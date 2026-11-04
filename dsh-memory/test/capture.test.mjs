import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/db.js'
import { Search } from '../src/search.js'
import { Writer } from '../src/evict.js'
import { Journal } from '../src/journal.js'
import { Capture } from '../src/capture.js'
import { resolveConfig } from '../src/config.js'

function world(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dshmem-capture-'))
  const config = { ...resolveConfig({ gapMinutes: 0 }), ...overrides }
  const store = new Store(join(dir, 'engram.db'))
  const search = new Search(store, { dims: 384, recencyBoost: 0 })
  search.rebuild()
  const writer = new Writer({ store, index: search, config, auditPath: join(dir, 'log', 'm.jsonl') })
  const journal = new Journal({ dir: join(dir, 'journal'), maxBytes: 1 << 20 })
  const capture = new Capture({ store, writer, search, journal, config, pressureOf: () => null })
  return {
    dir,
    config,
    store,
    search,
    writer,
    journal,
    capture,
    newCapture() {
      return new Capture({ store, writer, search, journal, config, pressureOf: () => null })
    },
    close() {
      capture.disposeAll()
      store.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

const session = (id = 's1', cwd = 'C:\\work\\demo') => ({ id, header: { cwd }, requestContext: () => ({ contextWindow: 128000 }) })

function turn(id, startAt, { reason = { kind: 'completed' }, toolError = false } = {}) {
  return [
    { type: 'turn/start', seq: 1, time: startAt, data: { turn: id } },
    {
      type: 'user/message',
      seq: 2,
      time: startAt + 1000,
      data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `任务 ${id}：修复沙箱拒写` }] },
    },
    {
      type: 'tool/call',
      seq: 3,
      time: startAt + 2000,
      data: { turn: id, step: 1, callId: 'c1', name: 'pwsh', arguments: JSON.stringify({ command: 'Get-ChildItem $env:TEMP' }) },
    },
    {
      type: 'tool/result',
      seq: 4,
      time: startAt + 3000,
      data: {
        turn: id,
        step: 1,
        message: {
          role: 'tool',
          toolCallId: 'c1',
          isError: toolError,
          source: { kind: 'tool', callId: 'c1' },
          content: [{ type: 'text', text: toolError ? 'Access is denied.' : 'ok' }],
        },
      },
    },
    { type: 'turn/end', seq: 5, time: startAt + 4000, data: { turn: id, reason } },
  ]
}

test('a finished turn is persisted with its timestamped transcript', () => {
  const w = world()
  try {
    const s = session()
    for (const event of turn(1, Date.now() - 10000)) w.capture.observe(s, event)

    const counts = w.store.counts()
    assert.equal(counts.memories, 1)
    const memories = w.store.allMemories()
    assert.equal(memories[0].turn, 1)
    assert.equal(memories[0].project, 'demo')
    assert.ok(memories[0].content.includes('用户'))
    assert.ok(memories[0].content.includes('工具 pwsh'))
    assert.match(memories[0].content, /## \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/)
    assert.equal(memories[0].outcome, 'success')
  } finally {
    w.close()
  }
})

test('a failed tool call marks the turn partial', () => {
  const w = world()
  try {
    const s = session()
    for (const event of turn(1, Date.now() - 10000, { toolError: true })) w.capture.observe(s, event)
    assert.equal(w.store.allMemories()[0].outcome, 'partial')
  } finally {
    w.close()
  }
})

test('memory_save links the current turn memory to its episode', () => {
  const w = world()
  try {
    const s = session()
    const start = Date.now() - 5000
    const events = turn(1, start)
    for (const event of events.slice(0, 4)) w.capture.observe(s, event)

    const { episode } = w.capture.saveExplicit(s, {
      title: '修复沙箱',
      action: '修复沙箱拒写',
      flow: ['检查 ACL'],
      outcome: 'success',
      outcomeNote: '',
      tags: ['pwsh'],
      summary: '修复沙箱拒写；结果：成功',
    })
    assert.ok(episode)

    w.capture.observe(s, events[4])
    const links = w.store.episodeMemoryIds(episode.id)
    assert.equal(links.length, 1)
    assert.equal(w.store.getEpisode(episode.id).memoryCount, 1)
    assert.equal(w.search.episodes.get(episode.id).hits, 0, 'new episode is recall-safe before DB reload')
    const memory = w.store.allMemories()[0]
    assert.equal(w.search.memories.get(memory.id).hits, 0, 'new memory is recall-safe before DB reload')
  } finally {
    w.close()
  }
})

test('subagent explicit saves are skipped when includeSubagents is false', () => {
  const w = world()
  try {
    const sub = { id: 'sub1', header: { origin: 'subagent', cwd: 'C:\\work\\demo' } }
    const result = w.capture.saveExplicit(sub, {
      title: 'sub', action: 'sub', flow: [], outcome: 'success',
      outcomeNote: '', tags: [], summary: 'sub',
    })
    assert.equal(result.skipped, 'subagent')
    assert.equal(w.store.counts().episodes, 0)
  } finally {
    w.close()
  }
})

test('subagent explicit saves are recorded when includeSubagents is true', () => {
  const w = world({ includeSubagents: true })
  try {
    const sub = { id: 'sub1', header: { origin: 'subagent', cwd: 'C:\\work\\demo' } }
    const result = w.capture.saveExplicit(sub, {
      title: 'sub', action: 'sub', flow: [], outcome: 'success',
      outcomeNote: '', tags: [], summary: 'sub',
    })
    assert.ok(result.episode)
    assert.equal(w.store.counts().episodes, 1)
  } finally {
    w.close()
  }
})

test('a failed memory write is retried instead of dropped', () => {
  const w = world()
  try {
    const s = session()
    const original = w.writer.write.bind(w.writer)
    let calls = 0
    w.writer.write = (...args) => {
      if (calls++ < 2) throw new Error('disk full')
      return original(...args)
    }

    for (const event of turn(1, Date.now() - 5000)) w.capture.observe(s, event)
    assert.equal(w.store.counts().memories, 0)
    assert.equal(w.capture.stateOf('s1').pending.length, 1)

    w.capture.flushPending(w.capture.stateOf('s1'))
    assert.equal(w.store.counts().memories, 1)
    assert.equal(w.capture.stateOf('s1').pending.length, 0)
  } finally {
    w.close()
  }
})

test('an event after a long gap closes the idle segment first', () => {
  const w = world({ gapMinutes: 60 })
  try {
    const s = session()
    for (const event of turn(1, Date.now() - 9000000)) w.capture.observe(s, event)
    assert.equal(w.store.counts().episodes, 0, 'nothing is due yet')

    // pretend the process (or the laptop) slept for two hours
    w.capture.stateOf('s1').lastEventAt = Date.now() - 7200000
    w.capture.observe(s, { type: 'turn/start', seq: 99, time: Date.now(), data: { turn: 2 } })

    assert.equal(w.store.counts().episodes, 1)
    assert.equal(w.store.allEpisodes()[0].trigger, 'idle_1h')
    assert.equal(w.store.episodeMemoryIds(w.store.allEpisodes()[0].id).length, 1)
  } finally {
    w.close()
  }
})

test('activation closes a session that is already idle past the gap', () => {
  const w = world()
  try {
    const s = session()
    const events = turn(1, Date.now() - 600000)
    for (const event of events) w.capture.observe(s, event)
    assert.equal(w.store.counts().episodes, 0)

    const capture2 = new Capture({
      store: w.store, writer: w.writer, search: w.search, journal: w.journal,
      config: { ...w.config, gapMinutes: 0.001 }, pressureOf: () => null,
    })
    const live = { id: 's1', header: s.header, snapshotEvents: () => events }
    assert.equal(capture2.reconcileIdle(live), true)
    assert.equal(w.store.counts().episodes, 1)
    assert.equal(w.store.allEpisodes()[0].trigger, 'idle_1h')
    capture2.disposeAll()
  } finally {
    w.close()
  }
})

test('activation re-arms the timer when the session is not idle yet', () => {
  const w = world()
  try {
    const s = session()
    const events = turn(1, Date.now() - 1000)
    for (const event of events) w.capture.observe(s, event)

    const capture2 = new Capture({
      store: w.store, writer: w.writer, search: w.search, journal: w.journal,
      config: { ...w.config, gapMinutes: 60 }, pressureOf: () => null,
    })
    const live = { id: 's1', header: s.header, snapshotEvents: () => events }
    assert.equal(capture2.reconcileIdle(live), false)
    assert.equal(w.store.counts().episodes, 0, 'no episode while the gap has not elapsed')
    assert.ok(capture2.stateOf('s1').timer, 'the idle timer is re-armed')
    capture2.disposeAll()
  } finally {
    w.close()
  }
})

test('an idle close failure is logged instead of thrown', () => {
  const w = world({ gapMinutes: 0.001 })
  try {
    const s = session()
    const state = w.capture.state(s)
    state.lastEventAt = Date.now() - 60000
    w.capture.closeEpisode = () => { throw new Error('boom') }
    assert.doesNotThrow(() => w.capture.runIdleCheck(s, state, 1000))
  } finally {
    w.close()
  }
})

test('closing an episode journals the transcripts before writing the summary', () => {
  const w = world()
  try {
    const s = session()
    for (const event of turn(1, Date.now() - 9000000)) w.capture.observe(s, event)
    const state = w.capture.stateOf('s1')
    const episode = w.capture.closeEpisode(s, state, 'idle_1h', '空闲 60 分钟')

    assert.ok(episode)
    assert.equal(episode.trigger, 'idle_1h')
    assert.equal(w.store.episodeMemoryIds(episode.id).length, 1)

    const files = readdirSync(join(w.dir, 'journal'))
    assert.equal(files.length, 1)
    const text = readFileSync(join(w.dir, 'journal', files[0]), 'utf8')
    assert.ok(text.includes('trigger=idle_1h'))
    assert.ok(text.includes('工具 pwsh'))
    assert.ok(text.indexOf('trigger=idle_1h') >= 0)
  } finally {
    w.close()
  }
})

test('a session with no pending memories creates no episode', () => {
  const w = world()
  try {
    const s = session()
    const state = w.capture.state(s)
    assert.equal(w.capture.closeEpisode(s, state, 'idle_1h', 'x'), null)
    assert.equal(w.store.counts().episodes, 0)
  } finally {
    w.close()
  }
})

test('disposing a session flushes the last turn and closes the episode', () => {
  const w = world()
  try {
    const s = session()
    const events = turn(7, Date.now() - 2000)
    for (const event of events.slice(0, 4)) w.capture.observe(s, event)
    w.capture.dispose(s)
    assert.equal(w.store.counts().memories, 1)
    assert.equal(w.store.counts().episodes, 1)
    assert.equal(w.store.allEpisodes()[0].trigger, 'session_end')
  } finally {
    w.close()
  }
})

test('a reload resumes the in-flight turn and keeps one episode per task', () => {
  const w = world()
  try {
    const s = session()
    const events = turn(1, Date.now() - 5000)
    for (const event of events.slice(0, 4)) w.capture.observe(s, event)
    const { episode } = w.capture.saveExplicit(s, {
      title: '修复沙箱',
      action: '修复沙箱拒写',
      flow: ['检查 ACL'],
      outcome: 'success',
      outcomeNote: '',
      tags: [],
      summary: '修复沙箱拒写；结果：成功',
    })

    // --- plugin reload: a brand-new Capture over the same store ---
    const capture2 = w.newCapture()
    const restored = { id: s.id, header: s.header, snapshotEvents: () => events.slice(0, 4) }
    assert.equal(capture2.resume(restored), true)

    capture2.observe(restored, events[4])

    assert.equal(w.store.counts().memories, 1, 'exactly one memory for the turn')
    const memory = w.store.allMemories()[0]
    assert.ok(memory.content.includes('任务 1'), 'the pre-reload transcript is restored')
    assert.deepEqual(
      w.store.episodeMemoryIds(episode.id),
      [memory.id],
      'the memory joins the episode created before the reload',
    )
    assert.equal(w.store.getEpisode(episode.id).memoryCount, 1)
    assert.equal(w.store.counts().episodes, 1, 'no second episode was created')
    capture2.disposeAll()
  } finally {
    w.close()
  }
})

test('resume ignores a session whose turn already ended', () => {
  const w = world()
  try {
    const s = session()
    const events = turn(1, Date.now() - 5000)
    const finished = { id: s.id, header: s.header, snapshotEvents: () => events }
    assert.equal(w.capture.resume(finished), false)
    assert.equal(w.capture.stateOf('s1'), undefined, 'no state is created for a finished session')
  } finally {
    w.close()
  }
})

test('resume never overwrites a buffer that already holds events', () => {
  const w = world()
  try {
    const s = session()
    const events = turn(1, Date.now() - 5000)
    w.capture.observe(s, events[0])
    const snapshot = { id: s.id, header: s.header, snapshotEvents: () => events }
    assert.equal(w.capture.resume(snapshot), false)
    assert.equal(w.capture.stateOf('s1').events.length, 1)
  } finally {
    w.close()
  }
})