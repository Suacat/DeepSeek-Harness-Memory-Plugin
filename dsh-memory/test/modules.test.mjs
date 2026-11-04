import test from 'node:test'
import assert from 'node:assert/strict'
import { Capture } from '../src/capture.js'
import { Journal } from '../src/journal.js'
import { registerTools } from '../src/tools.js'
import { MEMORY_SECTION } from '../src/prompt.js'
import { defaultDataDir, resolveConfig } from '../src/config.js'

test('capture, journal, tools and prompt load without the harness runtime', () => {
  assert.equal(typeof Capture, 'function')
  assert.equal(typeof Journal, 'function')
  assert.equal(typeof registerTools, 'function')
  assert.ok(MEMORY_SECTION.text.length > 20)
})

test('config resolution applies defaults and clamps bad values', () => {
  const config = resolveConfig({})
  assert.equal(config.capacityBytes, 1024 * 1024 * 1024)
  assert.equal(config.recallTokenBudget, 5200)
  assert.equal(config.journalMaxBytes, 1024 * 1024)
  assert.equal(config.gapMinutes, 60)
  assert.equal(config.embedDims, 384)

  const clamped = resolveConfig({ capacityBytes: 10, pressureRatio: 5, embedDims: 1, detailMaxChars: 1 })
  assert.equal(clamped.capacityBytes, 1024)
  assert.equal(clamped.pressureRatio, 1)
  assert.equal(clamped.embedDims, 32)
  assert.equal(clamped.detailMaxChars, 1000)

  assert.equal(resolveConfig({ capacityBytes: -5 }).capacityBytes, 1024 * 1024 * 1024, 'invalid values fall back to defaults')
})

test('default data dir lives under DSH_HOME', () => {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = 'C:\\tmp\\dsh-home'
  try {
    assert.equal(defaultDataDir(), 'C:\\tmp\\dsh-home\\engram')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})