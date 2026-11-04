/** Plugin configuration: defaults, clamping and data-directory resolution. */

import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULTS = {
  enabled: true,
  dataDir: '',
  capacityBytes: 1024 * 1024 * 1024,
  evictGraceDays: 7,
  gapMinutes: 60,
  pressureRatio: 0.8,
  embedDims: 384,
  recallLimit: 5,
  recallTokenBudget: 5200,
  detailMaxChars: 24000,
  journalMaxBytes: 1024 * 1024,
  includeSubagents: false,
  recencyBoost: 0.15,
}

function positive(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function nonNegative(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

export function resolveConfig(input = {}) {
  const merged = { ...DEFAULTS, ...(input ?? {}) }
  return {
    enabled: merged.enabled !== false,
    dataDir: typeof merged.dataDir === 'string' ? merged.dataDir.trim() : '',
    capacityBytes: Math.max(1024, Math.floor(positive(merged.capacityBytes, DEFAULTS.capacityBytes))),
    evictGraceDays: Math.min(3650, nonNegative(merged.evictGraceDays, DEFAULTS.evictGraceDays)),
    gapMinutes: Math.max(0, Number(merged.gapMinutes) || 0),
    pressureRatio: Math.min(1, Math.max(0.05, Number(merged.pressureRatio) || DEFAULTS.pressureRatio)),
    embedDims: Math.max(32, Math.floor(positive(merged.embedDims, DEFAULTS.embedDims))),
    recallLimit: Math.max(1, Math.floor(positive(merged.recallLimit, DEFAULTS.recallLimit))),
    recallTokenBudget: Math.max(200, Math.floor(positive(merged.recallTokenBudget, DEFAULTS.recallTokenBudget))),
    detailMaxChars: Math.max(1000, Math.floor(positive(merged.detailMaxChars, DEFAULTS.detailMaxChars))),
    journalMaxBytes: Math.max(65536, Math.floor(positive(merged.journalMaxBytes, DEFAULTS.journalMaxBytes))),
    includeSubagents: merged.includeSubagents === true,
    recencyBoost: Math.min(1, Math.max(0, Number(merged.recencyBoost) || 0)),
  }
}

export function defaultDataDir() {
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return join(home, 'engram')
}