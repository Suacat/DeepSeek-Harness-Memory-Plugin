import test from 'node:test'
import assert from 'node:assert/strict'
import { capText, mergeEpisode, renderTranscript, summarizeTurn } from '../src/summarize.js'

const T0 = 1761690123456

function turnEvents({ user = '修复 pwsh 沙箱写不了的报错', command = 'Get-ChildItem $env:TEMP', reason = { kind: 'completed' } } = {}) {
  return [
    { type: 'turn/start', seq: 1, time: T0, data: { turn: 1 } },
    {
      type: 'user/message',
      seq: 2,
      time: T0 + 1000,
      data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: user }] },
    },
    {
      type: 'tool/call',
      seq: 3,
      time: T0 + 2000,
      data: { turn: 1, step: 1, callId: 'c1', name: 'pwsh', arguments: JSON.stringify({ command }) },
    },
    {
      type: 'tool/result',
      seq: 4,
      time: T0 + 3000,
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'tool',
          toolCallId: 'c1',
          isError: true,
          source: { kind: 'tool', callId: 'c1' },
          content: [{ type: 'text', text: 'Access is denied.' }],
        },
      },
    },
    { type: 'turn/end', seq: 5, time: T0 + 4000, data: { turn: 1, reason } },
  ]
}

test('summary starts with what was done and lists the operation flow', () => {
  const summary = summarizeTurn(turnEvents())
  assert.equal(summary.title, '修复 pwsh 沙箱写不了的报错')
  assert.ok(summary.action.startsWith('修复 pwsh 沙箱写不了的报错'))
  assert.ok(summary.flow[0].startsWith('运行 Get-ChildItem'))
  assert.equal(summary.outcome, 'partial', 'a completed turn whose tool failed is partial, not success')
  assert.ok(summary.outcomeNote.includes('工具失败'))
  assert.ok(summary.summary.startsWith(summary.action.split('（')[0]))
  assert.ok(summary.summary.includes('流程：'))
})

test('failed turn maps turn/end error into a note', () => {
  const summary = summarizeTurn(turnEvents({ reason: { kind: 'error', error: { message: 'boom' } } }))
  assert.equal(summary.outcome, 'failure')
  assert.equal(summary.outcomeNote, 'boom')
})

test('max-tokens and aborted map to failure and partial', () => {
  assert.equal(summarizeTurn(turnEvents({ reason: { kind: 'max-tokens' } })).outcome, 'failure')
  assert.equal(summarizeTurn(turnEvents({ reason: { kind: 'aborted' } })).outcome, 'partial')
})

test('transcript carries a timestamp on every section', () => {
  const text = renderTranscript(turnEvents())
  assert.match(text, /## \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} 用户/)
  assert.match(text, /## \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} 工具 pwsh/)
  assert.ok(text.includes('Access is denied.'))
})

test('capText keeps head and tail and marks the omission', () => {
  const long = 'x'.repeat(5000)
  const capped = capText(long, 1000)
  assert.equal(capped.truncated, true)
  assert.ok(capped.text.length < 1200)
  assert.ok(capped.text.includes('省略'))
})

test('mergeEpisode unions flow, keeps the worst outcome, keeps the last failure note', () => {
  const merged = mergeEpisode([
    { title: 'A', action: '做 A', flow: ['步1'], outcome: 'success', outcomeNote: '' },
    { title: 'B', action: '做 B', flow: ['步2', '步1'], outcome: 'failure', outcomeNote: '权限不足' },
  ])
  assert.equal(merged.title, 'A')
  assert.equal(merged.outcome, 'failure')
  assert.equal(merged.outcomeNote, '权限不足')
  assert.deepEqual(merged.flow, ['步1', '步2'])
  assert.ok(merged.action.includes('共 2 个回合'))
})