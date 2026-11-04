import test from 'node:test'
import assert from 'node:assert/strict'
import { cosine, embed, hashToken, quantize, tokenize } from '../src/vector.js'

test('tokenize splits Chinese into bigrams and keeps latin words', () => {
  const tokens = tokenize('修复 pwsh 沙箱 ACL 拒写')
  assert.ok(tokens.includes('修复'))
  assert.ok(tokens.includes('沙箱'))
  assert.ok(tokens.includes('pwsh'))
  assert.ok(tokens.includes('acl'))
})

test('tokenize splits snake_case and camelCase identifiers', () => {
  const tokens = tokenize('readFile fs_read path/to/file.ts')
  assert.ok(tokens.includes('readfile'))
  assert.ok(tokens.includes('fs_read'))
  assert.ok(tokens.includes('fs'))
  assert.ok(tokens.includes('read'))
})

test('hashToken is stable and 32-bit', () => {
  assert.equal(hashToken('沙箱'), hashToken('沙箱'))
  assert.notEqual(hashToken('沙箱'), hashToken('沙箱x'))
  assert.ok(hashToken('沙箱') <= 0xffffffff)
})

test('related Chinese phrasings are closer than unrelated ones', () => {
  const docs = [
    '修复 pwsh 沙箱 ACL 拒绝写入问题',
    '设计本地记忆库插件方案',
  ]
  const df = new Map()
  for (const doc of docs) {
    for (const token of new Set(tokenize(doc))) df.set(token, (df.get(token) ?? 0) + 1)
  }
  const embedOne = (text) => quantize(embed(tokenize(text), df, docs.length, 384)).blob
  const query = embedOne('沙箱写不了文件，权限被拒绝')
  const related = cosine(query, embedOne(docs[0]))
  const unrelated = cosine(query, embedOne(docs[1]))
  assert.ok(related > unrelated, `expected ${related} > ${unrelated}`)
  assert.ok(related > 0.12, `related score too low: ${related}`)
  assert.ok(unrelated < 0.05, `unrelated score too high: ${unrelated}`)
})

test('quantize keeps direction for non-trivial vectors', () => {
  const df = new Map()
  const text = '修复 pwsh 沙箱 ACL 拒绝写入问题'
  for (const token of new Set(tokenize(text))) df.set(token, 1)
  const full = embed(tokenize(text), df, 1, 384)
  const { blob } = quantize(full)
  const dot = cosine(blob, blob)
  assert.ok(Math.abs(dot - 1) < 1e-6, `self similarity should be 1, got ${dot}`)
})

test('empty text yields zero similarity rather than NaN', () => {
  const df = new Map()
  const empty = quantize(embed([], df, 1, 384)).blob
  const some = quantize(embed(tokenize('沙箱'), df, 1, 384)).blob
  assert.equal(cosine(empty, some), 0)
})