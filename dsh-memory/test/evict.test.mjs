import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/db.js'
import { Search } from '../src/search.js'
import { Writer } from '../src/evict.js'

const DAY = 86400000

function world({ capacityBytes = 1e9, evictGraceDays = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dshmem-evict-'))
  const store = new Store(join(dir, 'engram.db'))
  const search = new Search(store, { dims: 384, recencyBoost: 0 })
  search.rebuild()
  const writer = new Writer({
    store,
    index: search,
    config: { capacityBytes, embedDims: 384, evictGraceDays },
    auditPath: join(dir, 'log', 'maintenance.jsonl'),
  })
  return {
    dir,
    store,
    search,
    writer,
    close() {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

let counter = 0
function makeMemory(world, { id, turn, size = 200, at = 1000 + counter++, contentLength = 100, contentState = 'full' }) {
  counter += 1
  const { vec, vecScale } = world.search.encodeFor('memory', `${id} 沙箱 记忆`)
  return {
    id: id ?? `m${counter}`,
    sessionId: 's1',
    turn: turn ?? counter,
    project: 'p',
    cwd: '/p',
    tsStart: at,
    tsEnd: at,
    title: id ?? `m${counter}`,
    summary: '沙箱 测试',
    flow: [],
    outcome: 'success',
    outcomeNote: '',
    tags: [],
    content: contentState === 'full' ? 'x'.repeat(contentLength) : null,
    contentState,
    bytes: size,
    contentBytes: contentState === 'full' ? contentLength : 0,
    addedBytes: size + (contentState === 'full' ? contentLength : 0),
    vec,
    vecScale,
  }
}

function forceAlpha(store, alpha) {
  store.setMeta('alpha', alpha)
  store.setMeta('calls_since_avg', 0)
}

test('first write primes g_avg from the first entry and deletes nothing', () => {
  const w = world()
  try {
    const record = w.writer.write('memory', makeMemory(w, { id: 'm1', size: 1000 }))
    assert.equal(record.first, true)
    assert.equal(record.n, 0)
    assert.equal(w.store.getMeta('g_avg'), 1100, 'g_avg equals the first entry size (bytes + content)')
    assert.ok(Math.abs(w.store.getMeta('alpha') - 1100 / 1e9) < 1e-12)
    assert.equal(w.store.getMeta('calls_since_avg'), 0)
    assert.equal(w.store.counts().entries, 1)
  } finally {
    w.close()
  }
})

test('alpha is cached: it only changes when the call threshold recomputes it', () => {
  const w = world()
  try {
    w.writer.write('memory', makeMemory(w, { id: 'm1', size: 1000, at: 1 }))
    const alpha1 = w.store.getMeta('alpha')

    w.writer.write('memory', makeMemory(w, { id: 'm2', size: 3000, at: 2 }))
    assert.equal(w.store.getMeta('alpha'), alpha1, 'alpha must not be recomputed below the threshold')
    assert.equal(w.store.getMeta('calls_since_avg'), 1)
    assert.equal(w.store.getMeta('bytes_added_since_avg'), 3100)

    w.writer.write('memory', makeMemory(w, { id: 'm3', size: 1000, at: 3 }))
    const gAvg = w.store.getMeta('g_avg')
    assert.equal(gAvg, 3100, 'g_avg is the average of the completed calls since the last reset')
    assert.ok(Math.abs(w.store.getMeta('alpha') - 3100 / 1e9) < 1e-12)
    assert.equal(w.store.getMeta('calls_since_avg'), 1, 'counter restarted after the recompute')
    assert.equal(w.store.getMeta('bytes_added_since_avg'), 1100)
  } finally {
    w.close()
  }
})

test('floor(alpha * N) deletes nothing while alpha * N < 1', () => {
  const w = world({ capacityBytes: 1e12 })
  try {
    for (let i = 0; i < 50; i++) w.writer.write('memory', makeMemory(w, { size: 200, at: 1000 + i }))
    assert.equal(w.store.counts().entries, 50)
    for (const record of w.writer.recent.slice(-10)) assert.equal(record.n, 0)
  } finally {
    w.close()
  }
})

test('two-stage eviction trims the transcript first, then removes the row', () => {
  const w = world()
  try {
    w.writer.write('memory', makeMemory(w, { id: 'm1', size: 100, at: 1, contentLength: 500, turn: 1 }))
    w.writer.write('memory', makeMemory(w, { id: 'm2', size: 100, at: 2, contentLength: 500, turn: 2 }))

    forceAlpha(w.store, 0.5)
    const first = w.writer.write('memory', makeMemory(w, { id: 'm3', size: 100, at: 3, turn: 3 }))
    assert.equal(first.n, 1)
    assert.deepEqual(first.deleted, ['m1'])
    assert.equal(w.store.getMemory('m1').content, null)
    assert.equal(w.store.getMemory('m1').contentState, 'trimmed')
    assert.equal(w.store.getMemory('m2').contentState, 'full')

    forceAlpha(w.store, 0.5)
    const second = w.writer.write('memory', makeMemory(w, { id: 'm4', size: 100, at: 4, turn: 4 }))
    assert.equal(second.n, 1)
    assert.equal(w.store.getMemory('m1'), undefined, 'already-trimmed memory is removed on the next pass')
  } finally {
    w.close()
  }
})

test('deleting an episode trims the transcripts it was the last owner of', () => {
  const w = world()
  try {
    const memory = makeMemory(w, { id: 'm1', size: 100, at: 5, contentLength: 400, turn: 1 })
    w.writer.write('memory', memory)
    w.writer.write('episode', {
      id: 'ep1',
      createdAt: 1,
      trigger: 'explicit_save',
      triggerNote: null,
      sessionId: 's1',
      project: 'p',
      cwd: '/p',
      tsStart: 1,
      tsEnd: 5,
      title: 'ep',
      action: 's',
      flow: [],
      outcome: 'success',
      outcomeNote: '',
      tags: [],
      memoryCount: 1,
      bytes: 100,
      addedBytes: 100,
      vec: null,
      vecScale: null,
    })
    w.store.linkEpisode('ep1', ['m1'])

    forceAlpha(w.store, 0.5)
    w.writer.write('memory', makeMemory(w, { id: 'm2', size: 100, at: 6, turn: 2 }))

    assert.equal(w.store.getEpisode('ep1'), undefined)
    const survivor = w.store.getMemory('m1')
    assert.ok(survivor, 'memory row survives its last summary being deleted')
    assert.equal(survivor.content, null)
    assert.equal(survivor.contentState, 'trimmed')
  } finally {
    w.close()
  }
})

test('a capacity change recomputes alpha from the cached g_avg', () => {
  const w = world({ capacityBytes: 1e9 })
  try {
    w.writer.write('memory', makeMemory(w, { id: 'm1', size: 1000, at: 1, turn: 1 }))
    const gAvg = w.store.getMeta('g_avg')
    assert.equal(w.store.getMeta('capacity_bytes'), 1e9)

    new Writer({
      store: w.store,
      index: w.search,
      config: { capacityBytes: 2e9, embedDims: 384 },
      auditPath: join(w.dir, 'log', 'm2.jsonl'),
    })

    assert.equal(w.store.getMeta('capacity_bytes'), 2e9)
    assert.ok(Math.abs(w.store.getMeta('alpha') - gAvg / 2e9) < 1e-12)
  } finally {
    w.close()
  }
})

test('rows inside the grace window never become candidates', () => {
  const w = world({ evictGraceDays: 7 })
  try {
    const now = Date.now()
    w.writer.write('memory', makeMemory(w, { id: 'mOld', at: now - 8 * DAY, turn: 1 }))
    w.writer.write('memory', makeMemory(w, { id: 'mNew', at: now - DAY, turn: 2 }))
    forceAlpha(w.store, 0.5)

    const record = w.writer.write('memory', makeMemory(w, { id: 'mFresh', at: now, turn: 3 }))
    assert.equal(record.n, 1)
    assert.equal(record.eligible, 1)
    assert.equal(record.planned, 1)
    assert.deepEqual(record.deleted, ['mOld'])
    assert.equal(w.store.getMemory('mOld').contentState, 'trimmed')
    assert.equal(w.store.getMemory('mNew').contentState, 'full')
  } finally {
    w.close()
  }
})

test('a protected memory survives repeated evictions', () => {
  const w = world({ evictGraceDays: 7 })
  try {
    const now = Date.now()
    w.writer.write('memory', makeMemory(w, { id: 'mOld', at: now - 8 * DAY, turn: 1 }))
    w.writer.write('memory', makeMemory(w, { id: 'mNew', at: now - DAY, contentLength: 300, turn: 2 }))
    forceAlpha(w.store, 1)
    w.writer.write('memory', makeMemory(w, { id: 'm3', at: now, turn: 3 }))
    forceAlpha(w.store, 1)
    w.writer.write('memory', makeMemory(w, { id: 'm4', at: now, turn: 4 }))

    assert.equal(w.store.getMemory('mOld'), undefined, 'the old row is gone after two passes')
    assert.equal(w.store.getMemory('mNew').contentState, 'full')
    assert.equal(w.store.getMemory('mNew').content.length, 300)
  } finally {
    w.close()
  }
})

test('candidates are ordered by hits, then by age', () => {
  const w = world({ evictGraceDays: 7 })
  try {
    const now = Date.now()
    w.writer.write('memory', makeMemory(w, { id: 'mOld', at: now - 30 * DAY, turn: 1 }))
    w.writer.write('memory', makeMemory(w, { id: 'mMid', at: now - 8 * DAY, turn: 2 }))
    w.writer.write('memory', makeMemory(w, { id: 'mHot', at: now - 40 * DAY, turn: 3 }))
    w.store.db.prepare("UPDATE memories SET hits = 3 WHERE id = 'mHot'").run()

    forceAlpha(w.store, 0.9)
    const record = w.writer.write('memory', makeMemory(w, { id: 'mNew', at: now, turn: 4 }))
    assert.deepEqual(record.deleted, ['mOld', 'mMid'])
    assert.equal(w.store.getMemory('mHot').contentState, 'full')
  } finally {
    w.close()
  }
})

test('deleting an out-of-grace episode still trims its unowned memory', () => {
  const w = world({ evictGraceDays: 7 })
  try {
    const now = Date.now()
    w.writer.write('memory', makeMemory(w, { id: 'm1', at: now - 9 * DAY, contentLength: 400, turn: 1 }))
    w.writer.write('episode', {
      id: 'ep1',
      createdAt: now - 9 * DAY,
      trigger: 'explicit_save',
      triggerNote: null,
      sessionId: 's1',
      project: 'p',
      cwd: '/p',
      tsStart: now - 9 * DAY,
      tsEnd: now - 9 * DAY,
      title: 'ep',
      action: 's',
      flow: [],
      outcome: 'success',
      outcomeNote: '',
      tags: [],
      memoryCount: 1,
      bytes: 100,
      addedBytes: 100,
      vec: null,
      vecScale: null,
    })
    w.store.linkEpisode('ep1', ['m1'])

    forceAlpha(w.store, 0.5)
    const record = w.writer.write('memory', makeMemory(w, { id: 'm2', at: now, turn: 2 }))
    assert.deepEqual(record.deleted, ['ep1'])
    assert.equal(w.store.getEpisode('ep1'), undefined)
    const survivor = w.store.getMemory('m1')
    assert.equal(survivor.contentState, 'trimmed')
    assert.equal(survivor.summary, '沙箱 测试')
  } finally {
    w.close()
  }
})

test('a row becomes eligible once it ages past the grace window', () => {
  const w = world({ evictGraceDays: 7 })
  try {
    const now = Date.now()
    w.writer.write('memory', makeMemory(w, { id: 'm1', at: now - DAY, turn: 1 }))
    forceAlpha(w.store, 1)
    const fresh = w.writer.write('memory', makeMemory(w, { id: 'm2', at: now, turn: 2 }))
    assert.equal(fresh.planned, 0)
    assert.deepEqual(fresh.deleted, [])

    w.store.db.prepare('UPDATE memories SET ts_end = ? WHERE id = ?').run(now - 8 * DAY, 'm1')
    forceAlpha(w.store, 1)
    const aged = w.writer.write('memory', makeMemory(w, { id: 'm3', at: now, turn: 3 }))
    assert.deepEqual(aged.deleted, ['m1'])
    assert.equal(w.store.getMemory('m1').contentState, 'trimmed')
  } finally {
    w.close()
  }
})

test('the audit records cutoff, eligible and planned', () => {
  const w = world({ evictGraceDays: 7 })
  try {
    const now = Date.now()
    w.writer.write('memory', makeMemory(w, { id: 'm1', at: now - DAY, turn: 1 }))
    forceAlpha(w.store, 1)
    const record = w.writer.write('memory', makeMemory(w, { id: 'm2', at: now, turn: 2 }))
    assert.equal(record.n, 1)
    assert.equal(record.eligible, 0)
    assert.equal(record.planned, 0)
    assert.ok(Math.abs(record.cutoff - (record.ts - 7 * DAY)) < 1000)
    assert.deepEqual(record.deleted, [])
    assert.equal(w.writer.recentEvictions().at(-1).planned, 0)

    const line = readFileSync(join(w.dir, 'log', 'maintenance.jsonl'), 'utf8').trim().split('\n').at(-1)
    const audited = JSON.parse(line)
    assert.equal(audited.eligible, 0)
    assert.equal(audited.planned, 0)
    assert.ok(audited.cutoff > 0)
  } finally {
    w.close()
  }
})

test('grace 0 restores immediate eviction', () => {
  const w = world({ evictGraceDays: 0 })
  try {
    const now = Date.now()
    w.writer.write('memory', makeMemory(w, { id: 'm1', at: now - 5000, turn: 1 }))
    forceAlpha(w.store, 1)
    const record = w.writer.write('memory', makeMemory(w, { id: 'm2', at: now, turn: 2 }))
    assert.equal(record.eligible, 1)
    assert.deepEqual(record.deleted, ['m1'])
  } finally {
    w.close()
  }
})

test('a store where everything is protected still accepts writes', () => {
  const w = world({ evictGraceDays: 7 })
  try {
    const now = Date.now()
    w.writer.write('memory', makeMemory(w, { id: 'm1', at: now - DAY, turn: 1 }))
    forceAlpha(w.store, 1)
    const record = w.writer.write('memory', makeMemory(w, { id: 'm2', at: now, turn: 2 }))
    assert.equal(record.entries, 1)
    assert.equal(record.eligible, 0)
    assert.equal(record.planned, 0)
    assert.deepEqual(record.deleted, [])
    assert.equal(w.store.counts().entries, 2)
  } finally {
    w.close()
  }
})

test('eviction audit records alpha, n and the deleted ids', () => {
  const w = world()
  try {
    w.writer.write('memory', makeMemory(w, { id: 'm1', size: 100, at: 1, turn: 1 }))
    forceAlpha(w.store, 1)
    const record = w.writer.write('memory', makeMemory(w, { id: 'm2', size: 100, at: 2, turn: 2 }))
    assert.equal(record.alpha, 1)
    assert.equal(record.n, 1)
    assert.deepEqual(w.writer.recentEvictions().at(-1).deleted, ['m1'])
  } finally {
    w.close()
  }
})