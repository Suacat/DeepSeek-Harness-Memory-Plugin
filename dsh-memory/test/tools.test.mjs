import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/db.js'
import { Search } from '../src/search.js'
import { Writer } from '../src/evict.js'
import { registerTools } from '../src/tools.js'
import { resolveConfig } from '../src/config.js'

const DAY = 86400000

function world({ evictGraceDays = 7 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dshmem-tools-'))
  const config = resolveConfig({ evictGraceDays })
  const store = new Store(join(dir, 'engram.db'))
  const search = new Search(store, { dims: config.embedDims })
  search.rebuild()
  const writer = new Writer({ store, index: search, config, auditPath: join(dir, 'log', 'm.jsonl') })
  const tools = new Map()
  const ctx = {
    tools: { register: (def) => tools.set(def.name, def) },
    systemPrompt: { section: () => {} },
  }
  registerTools({ ctx, store, search, writer, capture: { resumeLog: [] }, config })
  return {
    dir,
    store,
    tools,
    close() {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

const episode = (id, at) => ({
  id,
  createdAt: at,
  trigger: 'explicit_save',
  triggerNote: null,
  sessionId: 's1',
  project: 'p',
  cwd: '/p',
  tsStart: at,
  tsEnd: at,
  title: id,
  action: 'a',
  flow: [],
  outcome: 'success',
  outcomeNote: '',
  tags: [],
  memoryCount: 0,
  bytes: 10,
})

const memory = (id, turn, at) => ({
  id,
  sessionId: 's1',
  turn,
  project: 'p',
  cwd: '/p',
  tsStart: at,
  tsEnd: at,
  title: id,
  summary: 's',
  flow: [],
  outcome: 'success',
  outcomeNote: '',
  tags: [],
  content: 'x',
  contentState: 'full',
  bytes: 10,
  contentBytes: 1,
})

test('memory_stats reports the eviction grace window', () => {
  const w = world({ evictGraceDays: 7 })
  try {
    const now = Date.now()
    w.store.insertEpisode(episode('epOld', now - 9 * DAY))
    w.store.insertMemory(memory('mOld', 1, now - 8 * DAY))
    w.store.insertMemory(memory('mNew', 2, now - DAY))
    w.store.setMeta('alpha', 0.5)

    const stats = w.tools.get('memory_stats').execute({}, {})
    assert.equal(stats.evictGraceDays, 7)
    assert.equal(stats.entries, 3)
    assert.equal(stats.evictableEntries, 2)
    assert.equal(stats.protectedEntries, 1)
    assert.equal(stats.nextEvictCount, 1)
    assert.equal(stats.nextEvictCandidates, 1)
  } finally {
    w.close()
  }
})

test('memory_stats clamps a bad grace value back to the default', () => {
  const w = world({ evictGraceDays: -3 })
  try {
    const stats = w.tools.get('memory_stats').execute({}, {})
    assert.equal(stats.evictGraceDays, 7)
  } finally {
    w.close()
  }
})