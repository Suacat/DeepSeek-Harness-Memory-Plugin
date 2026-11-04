/** Model-facing tool registrations (plain definitions, no harness imports). */

import { basename } from 'node:path'
import { estimateTokens, withinBudget } from './rank.js'
import { MEMORY_SECTION } from './prompt.js'

const OUTPUT = {
  schema: { type: 'object', additionalProperties: true, properties: {} },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
}

function projectOf(cwd) {
  if (!cwd) return undefined
  return basename(String(cwd).replace(/[\\/]+$/, '')) || undefined
}

function requireAgent(exec) {
  const agent = exec?.agent
  if (!agent?.session) throw new Error('memory tools require a calling agent session')
  return agent
}

export function registerTools({ ctx, store, search, writer, capture, config }) {
  ctx.systemPrompt.section({
    name: MEMORY_SECTION.name,
    order: 900,
    text: MEMORY_SECTION.text,
  })

  ctx.tools.register({
    name: 'memory_save',
    description:
      'Record the task just finished into the local memory store. Call once per task, on success or failure. ' +
      'The first sentence of `action` is what the user sees first when this memory is recalled.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action', 'outcome'],
      properties: {
        action: {
          type: 'string',
          description: 'One sentence: what was done, including the key object, file, or command.',
        },
        title: {
          type: 'string',
          description: 'Short title, at most 60 characters. Defaults to the first 40 characters of action.',
        },
        steps: {
          type: 'array',
          items: { type: 'string' },
          description: 'Concrete operation flow in order, one short step per item.',
        },
        outcome: {
          type: 'string',
          enum: ['success', 'failure', 'partial'],
          description: 'success, failure, or partial.',
        },
        note: {
          type: 'string',
          description: 'Result detail: failure reason, leftover work, or the next step.',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tags such as a tool or subsystem name.',
        },
        detail: {
          type: 'string',
          description:
            'Long-form content worth keeping verbatim (key error text, decision rationale, command output). ' +
            'When omitted, the current turn transcript is stored instead.',
        },
      },
    },
    output: OUTPUT,
    execute(args, exec) {
      const agent = requireAgent(exec)
      const session = agent.session
      if (capture.skipsSubagent(session)) {
        const counts = store.counts()
        return {
          ok: true,
          skipped: true,
          reason: 'subagent',
          episodeId: null,
          memoryIds: [],
          store: { entries: counts.entries, bytes: counts.bytes, capacity: config.capacityBytes },
        }
      }
      const steps = Array.isArray(args.steps) ? args.steps.filter((s) => typeof s === 'string' && s.trim()) : []
      const tags = Array.isArray(args.tags) ? args.tags.filter((t) => typeof t === 'string' && t.trim()) : []
      const action = String(args.action ?? '').trim()
      const title = (args.title?.trim() || action.slice(0, 40) || '未命名任务').slice(0, 60)
      const note = args.note?.trim() ?? ''
      const outcomeText =
        args.outcome === 'success'
          ? '成功'
          : args.outcome === 'failure'
            ? `失败${note ? `（${note}）` : ''}`
            : `部分完成${note ? `（${note}）` : ''}`
      const summary = [action, steps.length > 0 ? `流程：${steps.join(' → ')}` : '', `结果：${outcomeText}`]
        .filter(Boolean)
        .join('；')

      if (args.detail) capture.noteDetail(session.id, String(args.detail))

      const { episode, memoryIds } = capture.saveExplicit(session, {
        title,
        action,
        flow: steps,
        outcome: args.outcome,
        outcomeNote: note,
        tags,
        summary,
      })
      if (!episode) throw new Error('memory_save could not persist the episode; check the data directory')

      const counts = store.counts()
      return {
        ok: true,
        episodeId: episode.id,
        memoryIds,
        store: { entries: counts.entries, bytes: counts.bytes, capacity: config.capacityBytes },
      }
    },
  })

  ctx.tools.register({
    name: 'memory_recall',
    description:
      'Search memories. Returns summaries first (one per summarization trigger), then per-turn memories when slots remain. ' +
      'Use memory_open with the returned ids to read transcripts.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Natural-language query or keywords.' },
        limit: { type: 'integer', description: 'How many summaries to return, 1-20. Defaults to 5.' },
        project: {
          type: 'string',
          description: 'Project name. Defaults to the current working directory name.',
        },
        since: {
          type: 'string',
          description: 'Only memories ending after this time (ISO 8601 or epoch milliseconds).',
        },
        until: {
          type: 'string',
          description: 'Only memories ending before this time (ISO 8601 or epoch milliseconds).',
        },
        scope: {
          type: 'string',
          enum: ['project', 'all'],
          description: 'project (default) limits to the current project; all searches every project.',
        },
      },
    },
    output: OUTPUT,
    execute(args, exec) {
      const agent = requireAgent(exec)
      const session = agent.session
      const limit = Math.max(1, Math.min(20, Number(args.limit) || config.recallLimit))
      const project = args.scope === 'all' ? undefined : args.project?.trim() || projectOf(session.header?.cwd)
      const since = toEpoch(args.since)
      const until = toEpoch(args.until)

      const { episodes, memories } = search.recall({ query: args.query, limit, project, since, until })
      const cards = [
        ...episodes.map((hit) => cardOf('episode', hit.row)),
        ...memories.map((hit) => cardOf('memory', hit.row)),
      ]
      const budget = withinBudget(cards, config.recallTokenBudget, (card) =>
        `${card.title}${card.action}${(card.flow ?? []).join('')}`,
      )

      const keptIds = new Set(budget.items.map((card) => card.id))
      store.bumpHits('episode', episodes.filter((hit) => keptIds.has(hit.row.id)).map((hit) => hit.row.id))
      store.bumpHits('memory', memories.filter((hit) => keptIds.has(hit.row.id)).map((hit) => hit.row.id))

      return {
        items: budget.items,
        total: cards.length,
        hint:
          cards.length === 0
            ? '没有相关记忆。可以换个说法，或用 scope:"all" 扩大范围。'
            : budget.truncated
              ? `已按 token 预算截断，仅返回 ${budget.items.length}/${cards.length} 条。`
              : '摘要不足时用 memory_open 取原文。',
      }
    },
  })

  ctx.tools.register({
    name: 'memory_open',
    description: 'Read the stored transcript behind memory_recall results.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['ids'],
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Memory or episode ids returned by memory_recall. Episodes expand to their memories.',
        },
        maxChars: { type: 'integer', description: 'Per-item character cap. Defaults to 8000.' },
      },
    },
    output: OUTPUT,
    execute(args) {
      const maxChars = Math.max(200, Number(args.maxChars) || 8000)
      const ids = Array.isArray(args.ids) ? args.ids : []
      const items = []
      const missing = []

      for (const id of ids) {
        if (typeof id !== 'string') continue
        if (id.startsWith('ep_')) {
          if (!store.getEpisode(id)) {
            missing.push(id)
            continue
          }
          for (const memoryId of store.episodeMemoryIds(id)) {
            const memory = store.getMemory(memoryId)
            if (memory) items.push(detailOf(memory, maxChars))
          }
        } else {
          const memory = store.getMemory(id)
          if (!memory) missing.push(id)
          else items.push(detailOf(memory, maxChars))
        }
      }

      store.bumpHits('memory', items.map((item) => item.id))
      return { items, missing }
    },
  })

  ctx.tools.register({
    name: 'memory_stats',
    description: 'Read-only view of the local memory store: size, counters, eviction state.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: OUTPUT,
    execute() {
      const counts = store.counts()
      const alpha = store.getMeta('alpha', 0)
      const calls = store.getMeta('calls_since_avg', 0)
      const threshold = Math.max(1, Math.ceil(counts.entries / 2))
      const graceDays = Number.isFinite(config.evictGraceDays) ? config.evictGraceDays : 7
      const cutoff = Date.now() - graceDays * 86400000
      const { eligible } = store.evictableCount(cutoff)
      const nextEvictCount = Math.floor(alpha * counts.entries + 1e-9)
      return {
        entries: counts.entries,
        episodes: counts.episodes,
        memories: counts.memories,
        bytes: counts.bytes,
        capacity: config.capacityBytes,
        capacityAtRecompute: store.getMeta('capacity_bytes', null),
        recallTokenBudget: config.recallTokenBudget,
        journalMaxBytes: config.journalMaxBytes,
        gapMinutes: config.gapMinutes,
        embedDims: config.embedDims,
        alpha,
        gAvg: store.getMeta('g_avg', 0),
        callsSinceAvg: calls,
        nextRecomputeIn: Math.max(0, threshold - calls),
        nextEvictCount,
        evictGraceDays: graceDays,
        evictableEntries: eligible,
        protectedEntries: counts.entries - eligible,
        nextEvictCandidates: Math.min(nextEvictCount, eligible),
        recentEvictions: writer.recentEvictions(),
        resume: (capture.resumeLog ?? []).slice(-3),
        dbPath: store.dbPath,
      }
    },
  })
}

function cardOf(source, row) {
  const card = {
    id: row.id,
    source,
    time: row.tsEnd,
    title: row.title,
    action: row.action ?? row.summary,
    flow: row.flow ?? [],
    outcome: row.outcome,
    project: row.project ?? null,
    hits: row.hits ?? 0,
  }
  if (source === 'memory') card.memoryIds = [row.id]
  return card
}

function detailOf(memory, maxChars) {
  const body = memory.content ?? ''
  const truncated = body.length > maxChars
  return {
    id: memory.id,
    kind: 'memory',
    title: memory.title,
    time: memory.tsEnd,
    summary: memory.summary,
    body: truncated ? `${body.slice(0, maxChars)}\n…（截断，共 ${body.length} 字符）` : body,
    truncated,
    detailState: memory.contentState,
  }
}

function toEpoch(value) {
  if (!value) return undefined
  const text = String(value).trim()
  if (/^\d+$/.test(text)) {
    const n = Number(text)
    return Number.isFinite(n) ? n : undefined
  }
  const parsed = Date.parse(text)
  return Number.isNaN(parsed) ? undefined : parsed
}

export { estimateTokens }