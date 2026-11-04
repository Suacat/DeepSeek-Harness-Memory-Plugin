import test from 'node:test'
import assert from 'node:assert/strict'
import { Bm25Index, estimateTokens, rrf, withinBudget } from '../src/rank.js'

test('BM25 matches two-character Chinese queries', () => {
  const index = new Bm25Index()
  index.add('a', '修复 pwsh 沙箱 ACL 拒绝写入问题')
  index.add('b', '设计本地记忆库插件方案')
  const hits = index.search('沙箱')
  assert.equal(hits[0]?.id, 'a')
  assert.ok(hits.length >= 1)
})

test('BM25 ranks the relevant document first for multi-term queries', () => {
  const index = new Bm25Index()
  index.add('a', '修复 pwsh 沙箱 ACL 拒绝写入问题')
  index.add('b', '设计本地记忆库插件方案')
  index.add('c', '调整插件配置默认值')
  const hits = index.search('记忆库 插件')
  assert.equal(hits[0].id, 'b')
})

test('BM25 respects the allowed set and removal', () => {
  const index = new Bm25Index()
  index.add('a', '沙箱 ACL')
  index.add('b', '沙箱 权限')
  const only = index.search('沙箱', { allowed: new Set(['b']) })
  assert.deepEqual(only.map((h) => h.id), ['b'])
  index.remove('b')
  assert.equal(index.search('沙箱', { allowed: new Set(['b']) }).length, 0)
})

test('rrf merges rankings and rewards agreement', () => {
  const fused = rrf([
    [{ id: 'a' }, { id: 'b' }],
    [{ id: 'b' }, { id: 'a' }],
  ])
  assert.ok(fused.get('a') > 0)
  assert.equal(fused.get('a'), fused.get('b'))
  const single = rrf([[{ id: 'x' }]])
  assert.ok(single.get('x') > 0)
})

test('estimateTokens counts CJK heavier than latin', () => {
  assert.ok(estimateTokens('中文五个字') > estimateTokens('abcde'))
})

test('withinBudget keeps at least one item', () => {
  const items = [{ text: '很长'.repeat(500) }]
  const kept = withinBudget(items, 10, (item) => item.text)
  assert.equal(kept.items.length, 1)
  assert.equal(kept.truncated, false)
})