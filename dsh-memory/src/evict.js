/**
 * Write gate implementing the alpha eviction policy:
 *   g_avg / alpha are cached in meta and only recomputed at the call threshold;
 *   the number of candidates processed is floor(alpha * N);
 *   a memory loses its transcript first and its row only on a later pass.
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

function clamp01(value) {
  if (!Number.isFinite(value) || value <= 0) return 0
  return value > 1 ? 1 : value
}

export class Writer {
  constructor({ store, index, config, auditPath }) {
    this.store = store
    this.index = index
    this.config = config
    this.auditPath = auditPath
    this.recent = []
    mkdirSync(dirname(auditPath), { recursive: true })
    this.syncCapacity()
  }

  /**
   * capacityBytes is the denominator of alpha. When L changes, recompute alpha
   * from the cached g_avg without recomputing g_avg, so memory_stats never
   * reports a new capacity with an alpha derived from the old one.
   */
  syncCapacity() {
    const gAvg = this.store.getMeta('g_avg', null)
    if (gAvg === null) return
    const stored = this.store.getMeta('capacity_bytes', null)
    if (stored === this.config.capacityBytes) return
    this.store.setMeta('capacity_bytes', this.config.capacityBytes)
    this.store.setMeta('alpha', clamp01(gAvg / this.config.capacityBytes))
    console.log(
      `[dsh-memory] capacity changed ${stored ?? '(unset)'} -> ${this.config.capacityBytes}; ` +
      `alpha recomputed from cached g_avg`,
    )
  }

  /** Insert one row, running eviction first; `insideTx` shares the transaction. */
  write(kind, row, insideTx) {
    const entryBytes = row.addedBytes ?? row.bytes
    const insert = () => {
      if (kind === 'episode') this.store.insertEpisode(row)
      else this.store.insertMemory(row)
      this.index.add(kind, row)
      insideTx?.()
    }

    if (this.store.getMeta('g_avg', null) === null) {
      this.store.tx(insert)
      this.store.setMeta('g_avg', entryBytes)
      this.store.setMeta('alpha', clamp01(entryBytes / this.config.capacityBytes))
      this.store.setMeta('capacity_bytes', this.config.capacityBytes)
      this.store.setMeta('calls_since_avg', 0)
      this.store.setMeta('bytes_added_since_avg', 0)
      return { n: 0, deleted: [], alpha: this.store.getMeta('alpha', 0), gAvg: entryBytes, first: true }
    }

    const { entries: N } = this.store.counts()
    const calls = this.store.getMeta('calls_since_avg', 0)
    const added = this.store.getMeta('bytes_added_since_avg', 0)

    if (calls >= Math.max(1, Math.ceil(N / 2))) {
      const next = calls > 0 ? added / calls : entryBytes
      this.store.setMeta('g_avg', next)
      this.store.setMeta('alpha', clamp01(next / this.config.capacityBytes))
      this.store.setMeta('capacity_bytes', this.config.capacityBytes)
      this.store.setMeta('calls_since_avg', 0)
      this.store.setMeta('bytes_added_since_avg', 0)
    }

    const alpha = this.store.getMeta('alpha', 0)
    const n = Math.floor(alpha * N + 1e-9)

    // Rows younger than the grace window never enter the queue: a fresh row's
    // hits=0 only means "not recalled yet", not "unimportant".
    const now = Date.now()
    const graceDays = Number.isFinite(this.config.evictGraceDays) ? this.config.evictGraceDays : 7
    const cutoff = now - graceDays * 86400000
    const { eligible } = this.store.evictableCount(cutoff)
    const planned = Math.min(n, eligible)
    const deleted = []

    this.store.tx(() => {
      if (planned > 0) {
        for (const candidate of this.store.candidates(planned, cutoff)) {
          deleted.push(this.evictOne(candidate))
        }
      }
      insert()
      this.store.setMeta('calls_since_avg', this.store.getMeta('calls_since_avg', 0) + 1)
      this.store.setMeta('bytes_added_since_avg', this.store.getMeta('bytes_added_since_avg', 0) + entryBytes)
    })

    const record = {
      ts: now,
      alpha,
      gAvg: this.store.getMeta('g_avg', 0),
      cutoff,
      n,
      eligible,
      planned,
      deleted,
      entries: N,
    }
    this.recent.push(record)
    if (this.recent.length > 20) this.recent.shift()
    this.audit(record)
    return record
  }

  /** Two-stage action for one candidate; returns its id. */
  evictOne(candidate) {
    if (candidate.kind === 'episode') {
      const memoryIds = this.store.deleteEpisode(candidate.id)
      this.index.remove('episode', candidate.id)
      for (const memoryId of memoryIds) {
        if (this.store.memoryLinkCount(memoryId) !== 0) continue
        this.store.trimMemory(memoryId)
        this.index.markTrimmed(memoryId)
      }
      return candidate.id
    }
    const freed = this.store.trimMemory(candidate.id)
    if (freed > 0) {
      this.index.markTrimmed(candidate.id)
    } else {
      this.store.deleteMemory(candidate.id)
      this.index.remove('memory', candidate.id)
    }
    return candidate.id
  }

  audit(record) {
    try {
      appendFileSync(this.auditPath, `${JSON.stringify(record)}\n`, 'utf8')
    } catch {
      /* auditing must never break a write */
    }
  }

  recentEvictions() {
    return this.recent.slice(-5)
  }
}