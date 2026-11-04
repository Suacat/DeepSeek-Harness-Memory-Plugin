import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/db.js'
import { Search } from '../src/search.js'

function world({ dims = 384 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dshmem-search-'))
  const store = new Store(join(dir, 'engram.db'))
  const search = new Search(store, { dims, recencyBoost: 0 })
  search.rebuild()
  return {
    store,
    search,
    close() {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

function addMemory(w, { id, title, summary, project = 'p', tsEnd = 1000, turn }) {
  const { vec, vecScale } = w.search.encodeFor('memory', `${title}\n${summary}`)
  const row = {
    id,
    sessionId: 's1',
    turn,
    project,
    cwd: '/p',
    tsStart: tsEnd,
    tsEnd,
    title,
    summary,
    flow: [],
    outcome: 'success',
    outcomeNote: '',
    tags: [],
    content: `${title} 的原文`,
    contentState: 'full',
    bytes: 100,
    contentBytes: 40,
    hits: 0,
    vec,
    vecScale,
  }
  w.store.insertMemory(row)
  w.search.add('memory', row)
  return row
}

function addEpisode(w, { id, title, action, project = 'p', tsEnd = 1000, memoryIds = [] }) {
  const { vec, vecScale } = w.search.encodeFor('episode', `${title}\n${action}`)
  const row = {
    id,
    createdAt: tsEnd,
    trigger: 'explicit_save',
    triggerNote: null,
    sessionId: 's1',
    project,
    cwd: '/p',
    tsStart: tsEnd - 10,
    tsEnd,
    title,
    action,
    flow: ['运行 whitelist 命令'],
    outcome: 'success',
    outcomeNote: '',
    tags: [],
    memoryCount: memoryIds.length,
    bytes: 100,
    hits: 0,
    vec,
    vecScale,
  }
  w.store.insertEpisode(row)
  w.search.add('episode', row)
  if (memoryIds.length > 0) w.store.linkEpisode(id, memoryIds)
  return row
}

test('episodes are returned before memories', () => {
  const w = world()
  try {
    addMemory(w, { id: 'm1', title: '修复沙箱拒写', summary: '定位 ACL 并重建权限', turn: 1 })
    assert.equal(w.search.memories.get('m1').content, undefined, 'index must not retain transcripts')
    assert.ok(w.store.getMemory('m1').content, 'DB still has the transcript')
    addEpisode(w, { id: 'ep1', title: '修复沙箱 ACL', action: '定位并修复沙箱拒写问题', memoryIds: ['m1'] })
    addMemory(w, { id: 'm2', title: '沙箱配置说明', summary: '记录沙箱参数', turn: 2 })

    const { episodes, memories } = w.search.recall({ query: '沙箱', limit: 5, project: 'p' })
    assert.equal(episodes[0].row.id, 'ep1')
    assert.ok(memories.every((hit) => hit.row.id !== 'm1'), 'memories covered by a returned episode are skipped')
  } finally {
    w.close()
  }
})

test('memories fill the remaining slots when no episode matches', () => {
  const w = world()
  try {
    addMemory(w, { id: 'm9', title: '记忆库设计', summary: '本地向量索引与淘汰策略', turn: 9 })
    addEpisode(w, { id: 'ep9', title: '无关任务', action: '调整构建脚本', memoryIds: [] })

    const { episodes, memories } = w.search.recall({ query: '记忆库 向量', limit: 5, project: 'p' })
    assert.equal(episodes.length, 0)
    assert.equal(memories[0]?.row.id, 'm9')
  } finally {
    w.close()
  }
})

test('limit caps the episode stage and leaves no room for memories', () => {
  const w = world()
  try {
    addEpisode(w, { id: 'ep1', title: '沙箱问题 A', action: '修复沙箱', tsEnd: 2000 })
    addMemory(w, { id: 'm1', title: '沙箱问题 B', summary: '沙箱细节', turn: 1, tsEnd: 1000 })
    const { episodes, memories } = w.search.recall({ query: '沙箱', limit: 1, project: 'p' })
    assert.equal(episodes.length, 1)
    assert.equal(memories.length, 0)
  } finally {
    w.close()
  }
})

test('project filter excludes other projects but keeps global rows', () => {
  const w = world()
  try {
    addMemory(w, { id: 'm1', title: '沙箱 A', summary: '沙箱', project: 'other', turn: 1 })
    addMemory(w, { id: 'm2', title: '沙箱 B', summary: '沙箱', project: 'p', turn: 2 })
    const { memories } = w.search.recall({ query: '沙箱', limit: 5, project: 'p' })
    assert.deepEqual(memories.map((h) => h.row.id), ['m2'])
  } finally {
    w.close()
  }
})

test('rebuild does not load transcripts into the index', () => {
  const w = world()
  try {
    addMemory(w, { id: 'm1', title: '大原文', summary: '摘要', turn: 1 })
    const again = new Search(w.store, { dims: 384, recencyBoost: 0 })
    again.rebuild()
    assert.equal(again.memories.get('m1').content, undefined)
    assert.ok(w.store.getMemory('m1').content)
  } finally {
    w.close()
  }
})

test('changing embedDims re-encodes existing rows', () => {
  const w = world({ dims: 64 })
  try {
    addMemory(w, { id: 'm1', title: '沙箱', summary: '修复', turn: 1 })
    assert.equal(w.store.getMemory('m1').vec.length, 64)
    assert.equal(w.store.getMeta('embed_dims'), 64)

    const next = new Search(w.store, { dims: 128, recencyBoost: 0 })
    next.rebuild()

    assert.equal(w.store.getMeta('embed_dims'), 128)
    assert.equal(w.store.getMemory('m1').vec.length, 128)
    assert.equal(next.memories.get('m1').vec.length, 128)
  } finally {
    w.close()
  }
})

test('unrelated queries return nothing instead of noise', () => {
  const w = world()
  try {
    addMemory(w, { id: 'm1', title: '数据库迁移', summary: 'SQLite schema 升级', turn: 1 })
    const { episodes, memories } = w.search.recall({ query: '今天天气怎么样', limit: 5, project: 'p' })
    assert.equal(episodes.length + memories.length, 0)
  } finally {
    w.close()
  }
})