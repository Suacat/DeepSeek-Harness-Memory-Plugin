/** Turns raw session events into timestamped memory rows and episodes. */

import { basename } from 'node:path'
import { newEpisodeId, newMemoryId } from './ids.js'
import { capText, mergeEpisode, renderTranscript, summarizeTurn } from './summarize.js'

const MAX_BUFFER_EVENTS = 4000

function projectOf(cwd) {
  if (!cwd) return null
  return basename(cwd.replace(/[\\/]+$/, '')) || null
}

export class Capture {
  constructor({ store, writer, search, journal, config, pressureOf }) {
    this.store = store
    this.writer = writer
    this.search = search
    this.journal = journal
    this.config = config
    this.pressureOf = pressureOf
    this.sessions = new Map()
    this.timers = new Set()
  }

  state(session) {
    let state = this.sessions.get(session.id)
    if (state) return state
    state = {
      id: session.id,
      project: projectOf(session.header?.cwd),
      cwd: session.header?.cwd ?? null,
      events: [],
      lastEventAt: 0,
      episodes: [],
      pendingDetail: [],
      pending: [],
      written: new Set(),
      timer: null,
    }
    this.sessions.set(session.id, state)
    return state
  }

  stateOf(sessionId) {
    return this.sessions.get(sessionId)
  }

  skipsSubagent(session) {
    return session?.header?.origin === 'subagent' && !this.config.includeSubagents
  }

  /**
   * Rebuild the in-flight turn of one live session after a plugin (re)load:
   * replay the committed events after the last `turn/end`, and re-attach the
   * explicit saves that turn already produced so they are not split in two.
   */
  resume(session) {
    this.resumeLog ??= []
    const tag = String(session.id ?? '').slice(-6)
    const note = (reason, extra = {}) => {
      this.resumeLog.push({ tag, reason, ...extra })
      if (this.resumeLog.length > 20) this.resumeLog.shift()
      return false
    }

    if (this.skipsSubagent(session)) return note('subagent')
    let events
    try {
      events = session.snapshotEvents?.() ?? []
    } catch (error) {
      return note('snapshot-threw', { error: String(error?.message ?? error).slice(0, 120) })
    }
    if (!Array.isArray(events)) return note('no-snapshot')
    if (events.length === 0) return note('empty-snapshot')

    let lastEnd = -1
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].type === 'turn/end') {
        lastEnd = i
        break
      }
    }
    const tail = events.slice(lastEnd + 1)
    if (tail.length === 0) return note('no-open-turn', { total: events.length })
    const start = [...tail].reverse().find((event) => event.type === 'turn/start')
    if (!start) return note('no-turn-start', { tail: tail.length, types: tail.slice(0, 4).map((e) => e.type) })

    const state = this.state(session)
    if (state.events.length > 0) return note('buffer-not-empty', { buffered: state.events.length })

    state.events = tail.length > MAX_BUFFER_EVENTS ? tail.slice(-MAX_BUFFER_EVENTS) : tail
    state.lastEventAt = tail[tail.length - 1].time ?? Date.now()

    let attached = 0
    try {
      for (const id of this.store.episodesSince(session.id, start.time ?? 0)) {
        this.queueEpisode(state, id)
        attached += 1
      }
    } catch (error) {
      log(`resume could not re-attach episodes: ${error?.message ?? error}`)
    }
    this.resumeLog.push({ tag, reason: 'ok', events: state.events.length, attached })
    if (this.resumeLog.length > 20) this.resumeLog.shift()
    return true
  }

  /** Entry point for the `session/event` feed. */
  observe(session, event) {
    if (this.skipsSubagent(session)) return
    const state = this.state(session)
    this.flushPending(state)
    this.checkIdleGap(session, state)

    if (event.type === 'turn/start' && state.events.length > 0) this.finalize(session, state, true)

    state.events.push(event)
    if (state.events.length > MAX_BUFFER_EVENTS) {
      state.events.splice(0, state.events.length - MAX_BUFFER_EVENTS)
    }
    state.lastEventAt = event.time ?? Date.now()

    if (event.type !== 'turn/end') return

    this.finalize(session, state, false)
    const kind = event.data?.reason?.kind
    if (kind === 'max-tokens') {
      this.closeEpisode(session, state, 'max_tokens', '达到输出上限')
    } else {
      const pressure = this.pressureOf?.(session)
      if (pressure && pressure.ratio >= this.config.pressureRatio) {
        this.closeEpisode(session, state, 'context_pressure', `上下文占用 ${(pressure.ratio * 100).toFixed(0)}%`)
      }
    }
    this.scheduleIdle(session, state)
  }

  /** Session removed: flush the last turn and close the episode. */
  dispose(session) {
    const state = this.sessions.get(session.id)
    if (!state) return
    if (this.skipsSubagent(session)) {
      this.clearTimer(state)
      this.sessions.delete(session.id)
      return
    }
    this.flushPending(state)
    this.finalize(session, state, true)
    this.closeEpisode(session, state, 'session_end', '会话结束')
    this.clearTimer(state)
    this.sessions.delete(session.id)
  }

  clearTimer(state) {
    if (state.timer) {
      clearTimeout(state.timer)
      this.timers.delete(state.timer)
      state.timer = null
    }
  }

  scheduleIdle(session, state, delay) {
    this.clearTimer(state)
    const gap = this.config.gapMinutes * 60000
    if (!(gap > 0)) return
    const wait = Number.isFinite(delay) && delay > 0 ? delay : gap + 250
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      state.timer = null
      this.runIdleCheck(session, state, gap)
    }, wait)
    timer.unref?.()
    this.timers.add(timer)
    state.timer = timer
  }

  runIdleCheck(session, state, gap) {
    try {
      if (Date.now() - state.lastEventAt < gap) return
      this.closeEpisode(session, state, 'idle_1h', `空闲 ${this.config.gapMinutes} 分钟`)
    } catch (error) {
      log(`idle close failed: ${error?.message ?? error}`)
    }
  }

  /** A new event can arrive after the process slept past the gap: close that segment first. */
  checkIdleGap(session, state) {
    const gap = this.config.gapMinutes * 60000
    if (!(gap > 0) || !state.lastEventAt) return
    if (Date.now() - state.lastEventAt < gap) return
    try {
      this.closeEpisode(session, state, 'idle_1h', `空闲 ${this.config.gapMinutes} 分钟`)
    } catch (error) {
      log(`idle catch-up failed: ${error?.message ?? error}`)
    }
  }

  /**
   * Re-derive idle from the session's own persisted event times. DSH keeps the
   * `time` of every committed event, so a reload or restart can still tell how
   * long the session has been quiet: close the segment now when the gap has
   * already elapsed, otherwise re-arm the timer for the remaining time.
   */
  reconcileIdle(session) {
    if (this.skipsSubagent(session)) return false
    let events
    try {
      events = session.snapshotEvents?.() ?? []
    } catch {
      return false
    }
    if (!Array.isArray(events) || events.length === 0) return false

    const state = this.state(session)
    const last = events[events.length - 1]?.time
    if (typeof last === 'number') state.lastEventAt = Math.max(state.lastEventAt, last)

    const gap = this.config.gapMinutes * 60000
    if (!(gap > 0)) return false
    const idle = Date.now() - state.lastEventAt
    if (idle < gap) {
      this.scheduleIdle(session, state, gap - idle + 250)
      return false
    }
    try {
      return Boolean(this.closeEpisode(session, state, 'idle_1h', `空闲 ${this.config.gapMinutes} 分钟`))
    } catch (error) {
      log(`idle reconcile failed: ${error?.message ?? error}`)
      return false
    }
  }

  disposeAll() {
    for (const state of this.sessions.values()) this.flushPending(state)
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    this.sessions.clear()
  }

  // -------------------------------------------------------------- memory

  finalize(session, state, forced) {
    this.flushPending(state)
    if (state.events.length === 0) return
    const events = state.events
    const endedAt = events[events.length - 1]?.time ?? Date.now()
    const turnEnd = [...events].reverse().find((e) => e.type === 'turn/end')
    const turn = turnEnd?.data?.turn ?? this.turnOf(events)
    if (turn == null) return
    if (turnEnd == null && !forced) return

    const key = `${state.id}:${turn}`
    if (state.written.has(key)) {
      state.events = []
      state.episodes = []
      return
    }

    const summary = summarizeTurn(events)
    const raw = renderTranscript(events)
    const extra = state.pendingDetail.length > 0 ? `## 补充说明（memory_save）\n${state.pendingDetail.join('\n\n')}` : ''
    const capped = capText(extra ? `${raw}\n\n${extra}` : raw, this.config.detailMaxChars)
    const contentBytes = Buffer.byteLength(capped.text ?? '', 'utf8')
    const text = this.search.textOf({
      title: summary.title,
      summary: summary.summary,
      flow: summary.flow,
      tags: summary.tags,
      project: state.project,
    })
    const { vec, vecScale } = this.search.encodeFor('memory', text)
    const bytes =
      Buffer.byteLength(summary.summary, 'utf8') +
      Buffer.byteLength(summary.title, 'utf8') +
      this.config.embedDims +
      256

    const memory = {
      id: newMemoryId(endedAt),
      sessionId: state.id,
      turn,
      project: state.project,
      cwd: state.cwd,
      tsStart: events[0]?.time ?? endedAt,
      tsEnd: endedAt,
      title: capped.truncated ? `${summary.title}（已截断）` : summary.title,
      summary: summary.summary,
      flow: summary.flow,
      outcome: summary.outcome,
      outcomeNote: summary.outcomeNote,
      tags: summary.tags,
      content: capped.text,
      contentState: 'full',
      bytes,
      contentBytes,
      addedBytes: bytes + contentBytes,
      vec,
      vecScale,
    }

    const pending = {
      key,
      memory,
      episodeIds: [...state.episodes],
      endedAt,
    }
    if (!this.persistMemory(state, pending)) {
      state.pending.push(pending)
      log(`memory write queued for retry: turn=${turn} session=${state.id}`)
    }
    state.events = []
    state.episodes = []
    state.pendingDetail = []
  }

  /** Try to write one memory twice; return true when it landed. */
  persistMemory(state, pending) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        this.writer.write('memory', pending.memory, () => {
          for (const episodeId of pending.episodeIds) {
            this.store.linkEpisode(episodeId, [pending.memory.id], pending.endedAt)
          }
        })
        state.written.add(pending.key)
        return true
      } catch (error) {
        log(`memory write failed (attempt ${attempt + 1}/2): ${error?.message ?? error}`)
      }
    }
    return false
  }

  /** Retry memories that could not be written earlier (disk full, lock, ...). */
  flushPending(state) {
    if (!state.pending?.length) return
    const remaining = []
    for (const pending of state.pending) {
      if (!this.persistMemory(state, pending)) remaining.push(pending)
    }
    state.pending = remaining
    if (remaining.length > 0) log(`pending memory writes: ${remaining.length}`)
  }

  turnOf(events) {
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]
      if (event.type === 'turn/start') return event.data?.turn
      if (event.data?.turn != null) return event.data.turn
    }
    return null
  }

  /** Extra verbatim text a `memory_save` wants kept with the current turn. */
  noteDetail(sessionId, text) {
    const state = this.sessions.get(sessionId)
    if (!state || !text) return
    state.pendingDetail.push(String(text))
  }

  // ------------------------------------------------------------- episode

  /** Summarize every memory of this session that no episode covers yet. */
  closeEpisode(session, state, trigger, note) {
    const cutoff = trigger === 'idle_1h' ? Date.now() - this.config.gapMinutes * 60000 : Number.POSITIVE_INFINITY
    const rows = this.store.unlinkedMemories(session.id, cutoff)
    if (rows.length === 0) return null

    const tsStart = rows[0].tsStart
    const tsEnd = rows[rows.length - 1].tsEnd
    this.writeJournal(trigger, session, state, tsStart, tsEnd, rows, [])

    return this.createEpisode({
      sessionId: session.id,
      project: state.project,
      cwd: state.cwd,
      trigger,
      note,
      tsStart,
      tsEnd,
      merged: mergeEpisode(rows),
      rows,
    })
  }

  /** Explicit `memory_save`: journal the pending turns plus the live buffer. */
  saveExplicit(session, payload) {
    if (this.skipsSubagent(session)) {
      return { episode: null, memoryIds: [], skipped: 'subagent' }
    }
    const state = this.state(session)
    const rows = this.store.unlinkedMemories(session.id)
    const extra = state.events.length > 0 ? [renderTranscript(state.events)] : []
    const tsStart = rows[0]?.tsStart ?? state.events[0]?.time ?? Date.now()
    const tsEnd = state.events[state.events.length - 1]?.time ?? Date.now()

    this.writeJournal('explicit_save', session, state, tsStart, tsEnd, rows, extra)

    const episode = this.createEpisode({
      sessionId: session.id,
      project: state.project,
      cwd: state.cwd,
      trigger: 'explicit_save',
      note: payload.note ?? null,
      tsStart,
      tsEnd,
      merged: rows.length > 0 ? mergeEpisode(rows) : null,
      rows,
      override: payload,
    })
    if (episode) this.queueEpisode(state, episode.id)
    return { episode, memoryIds: rows.map((r) => r.id) }
  }

  writeJournal(trigger, session, state, start, end, rows, extra) {
    const blocks = rows.map((row) => row.content ?? `## ${row.title}\n（原文已回收）`)
    for (const block of extra) if (block) blocks.push(block)
    try {
      this.journal.append({
        trigger,
        sessionId: session.id,
        project: state.project,
        start,
        end,
        blocks: blocks.length > 0 ? blocks : ['（本段暂无已落盘原文）'],
      })
    } catch (error) {
      log(`journal append failed: ${error?.message ?? error}`)
    }
  }

  createEpisode({ sessionId, project, cwd, trigger, note, tsStart, tsEnd, merged, rows, override }) {
    const title = override?.title ?? merged?.title ?? '未命名任务'
    const action = override?.action ?? merged?.action ?? ''
    const flow = override?.flow ?? merged?.flow ?? []
    const outcome = override?.outcome ?? merged?.outcome ?? 'success'
    const outcomeNote = override?.outcomeNote ?? merged?.outcomeNote ?? ''
    const summaryText = override?.summary ?? merged?.summary ?? action
    const tags = override?.tags ?? []
    const text = this.search.textOf({ title, action, flow, tags, project })
    const { vec, vecScale } = this.search.encodeFor('episode', text)
    const bytes =
      Buffer.byteLength(summaryText, 'utf8') + Buffer.byteLength(title, 'utf8') + this.config.embedDims + 256
    const now = Date.now()

    const episode = {
      id: newEpisodeId(now),
      createdAt: now,
      trigger,
      triggerNote: note ?? null,
      sessionId,
      project,
      cwd,
      tsStart,
      tsEnd,
      title,
      action,
      flow,
      outcome,
      outcomeNote,
      tags,
      memoryCount: rows?.length ?? 0,
      bytes,
      addedBytes: bytes,
      vec,
      vecScale,
    }

    try {
      this.writer.write('episode', episode, () => {
        if (rows?.length > 0) this.store.linkEpisode(episode.id, rows.map((r) => r.id), now)
      })
    } catch (error) {
      log(`episode write failed: ${error?.message ?? error}`)
      return null
    }
    return episode
  }

  queueEpisode(state, episodeId) {
    if (episodeId && !state.episodes.includes(episodeId)) state.episodes.push(episodeId)
  }
}

function log(message) {
  try {
    console.error(`[dsh-memory] ${message}`)
  } catch {
    /* ignore */
  }
}