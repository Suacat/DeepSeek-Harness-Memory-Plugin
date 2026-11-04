import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HITS_MAX, Store } from '../src/db.js'

const DAY = 86400000

function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dshmem-db-'))
  const store = new Store(join(dir, 'engram.db'))
  try {
    return fn(store, dir)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

const episode = (id, at = 1000) => ({
  id,
  createdAt: at,
  trigger: 'explicit_save',
  triggerNote: null,
  sessionId: 's1',
  project: 'p',
  cwd: '/p',
  tsStart: at,
  tsEnd: at,
  title: 't-' + id,
  action: 'a',
  flow: [],
  outcome: 'success',
  outcomeNote: '',
  tags: [],
  memoryCount: 0,
  bytes: 100,
})

const memory = (id, turn, at = 1000) => ({
  id,
  sessionId: 's1',
  turn,
  project: 'p',
  cwd: '/p',
  tsStart: at,
  tsEnd: at,
  title: 'm-' + id,
  summary: 'summary',
  flow: [],
  outcome: 'success',
  outcomeNote: '',
  tags: [],
  content: 'x'.repeat(50),
  contentState: 'full',
  bytes: 20,
  contentBytes: 50,
})

test('stores rows, counts bytes and links memories to episodes', () => {
  withStore((store) => {
    store.insertEpisode(episode('ep1'))
    store.insertMemory(memory('m1', 1))
    store.insertMemory(memory('m2', 2))
    store.linkEpisode('ep1', ['m1', 'm2'])

    const counts = store.counts()
    assert.deepEqual(counts, { episodes: 1, memories: 2, entries: 3, bytes: 100 + 2 * (20 + 50) })
    assert.deepEqual(store.episodeMemoryIds('ep1'), ['m1', 'm2'])
    assert.equal(store.getEpisode('ep1').memoryCount, 2)
  })
})

test('rejects a duplicate (session_id, turn)', () => {
  withStore((store) => {
    store.insertMemory(memory('m1', 1))
    assert.throws(() => store.insertMemory(memory('m2', 1)), /UNIQUE/)
  })
})

test('trim keeps the summary row and frees only the transcript bytes', () => {
  withStore((store) => {
    store.insertMemory(memory('m1', 1))
    const freed = store.trimMemory('m1')
    assert.equal(freed, 50)
    const row = store.getMemory('m1')
    assert.equal(row.content, null)
    assert.equal(row.contentState, 'trimmed')
    assert.equal(row.summary, 'summary')
    assert.equal(store.trimMemory('m1'), 0, 'second trim is a no-op')
  })
})

test('deleting an episode returns its memories and clears the links', () => {
  withStore((store) => {
    store.insertEpisode(episode('ep1'))
    store.insertMemory(memory('m1', 1))
    store.linkEpisode('ep1', ['m1'])
    const ids = store.deleteEpisode('ep1')
    assert.deepEqual(ids, ['m1'])
    assert.equal(store.getEpisode('ep1'), undefined)
    assert.equal(store.memoryLinkCount('m1'), 0)
    assert.ok(store.getMemory('m1'), 'memory row survives episode deletion')
  })
})

test('deleting a linked memory refreshes the episode cached count', () => {
  withStore((store) => {
    store.insertEpisode(episode('ep1'))
    store.insertMemory(memory('m1', 1))
    store.insertMemory(memory('m2', 2))
    store.linkEpisode('ep1', ['m1', 'm2'])
    assert.equal(store.getEpisode('ep1').memoryCount, 2)

    assert.deepEqual(store.deleteMemory('m1'), ['ep1'], 'the episode is reported as affected')
    assert.equal(store.getEpisode('ep1').memoryCount, 1, 'the cached count follows the cascade')

    store.deleteMemory('m2')
    assert.equal(store.getEpisode('ep1').memoryCount, 0)
  })
})

test('candidates only include rows older than the grace cutoff', () => {
  withStore((store) => {
    const now = 1700000000000
    store.insertEpisode(episode('epOld', now - 9 * DAY))
    store.insertEpisode(episode('epNew', now - 1 * DAY))
    store.insertMemory(memory('mOld', 1, now - 8 * DAY))
    store.insertMemory(memory('mNew', 2, now - 2 * DAY))

    const cutoff = now - 7 * DAY
    assert.deepEqual(store.candidates(10, cutoff).map((row) => row.id), ['epOld', 'mOld'])
    assert.deepEqual(
      store.candidates(10, Number.MAX_SAFE_INTEGER).map((row) => row.id).sort(),
      ['epNew', 'epOld', 'mNew', 'mOld'].sort(),
    )
  })
})

test('candidates order by hits, then age, then id', () => {
  withStore((store) => {
    const now = 1700000000000
    store.insertEpisode(episode('epB', now - 10 * DAY))
    store.insertEpisode(episode('epA', now - 10 * DAY))
    store.insertMemory(memory('mMid', 1, now - 8 * DAY))

    const cutoff = now - DAY
    assert.deepEqual(store.candidates(10, cutoff).map((row) => row.id), ['epA', 'epB', 'mMid'])

    store.db.prepare("UPDATE episodes SET hits = 2 WHERE id = 'epA'").run()
    assert.deepEqual(store.candidates(10, cutoff).map((row) => row.id), ['epB', 'mMid', 'epA'])
  })
})

test('evictableCount reports eligible and total rows', () => {
  withStore((store) => {
    const now = 1700000000000
    store.insertEpisode(episode('epOld', now - 9 * DAY))
    store.insertMemory(memory('mOld', 1, now - 8 * DAY))
    store.insertMemory(memory('mNew', 2, now - DAY))

    const cutoff = now - 7 * DAY
    assert.deepEqual({ ...store.evictableCount(cutoff) }, { eligible: 2, total: 3 })
    assert.deepEqual({ ...store.evictableCount(Number.MAX_SAFE_INTEGER) }, { eligible: 3, total: 3 })
  })
})

test('hits stop at the numeric ceiling instead of overflowing', () => {
  withStore((store) => {
    store.insertMemory(memory('m1', 1))
    store.db.prepare('UPDATE memories SET hits = ? WHERE id = ?').run(HITS_MAX - 1, 'm1')
    store.bumpHits('memory', ['m1'])
    assert.equal(store.getMemory('m1').hits, HITS_MAX)
    store.bumpHits('memory', ['m1'])
    store.bumpHits('memory', ['m1'])
    assert.equal(store.getMemory('m1').hits, HITS_MAX)
  })
})

test('meta round-trips typed values and resets on demand', () => {
  withStore((store) => {
    store.setMeta('g_avg', 1234)
    store.setMeta('alpha', 0.5)
    assert.equal(store.getMeta('g_avg'), 1234)
    assert.equal(store.getMeta('alpha'), 0.5)
    assert.equal(store.getMeta('missing', 'fallback'), 'fallback')
  })
})