/** In-memory hybrid index (BM25 + hashed vectors) over persisted memory rows. */

import { Bm25Index, rrf } from './rank.js'
import { cosine, embed, quantize, tokenize } from './vector.js'

const DAY = 86400000

export class Search {
  constructor(store, { dims = 384, recencyBoost = 0.15 } = {}) {
    this.store = store
    this.dims = dims
    this.recencyBoost = recencyBoost
    this.episodes = new Map()
    this.memories = new Map()
    this.epIndex = new Bm25Index()
    this.memIndex = new Bm25Index()
  }

  /** Load every row once at activation. */
  rebuild() {
    this.episodes.clear()
    this.memories.clear()
    this.epIndex = new Bm25Index()
    this.memIndex = new Bm25Index()
    for (const row of this.store.allEpisodes()) this.add('episode', row)
    for (const row of this.store.indexMemories()) this.add('memory', row)
    this.ensureDims()
  }

  /** If dims changed (or vectors are missing), re-encode every row once. */
  ensureDims() {
    const stored = this.store.getMeta('embed_dims', null)
    const sample = this.firstVector()
    const metaMismatch = stored !== null && stored !== this.dims
    const vectorMismatch = sample !== undefined && sample.length !== this.dims
    if (metaMismatch || vectorMismatch) this.reindex()
    else this.store.setMeta('embed_dims', this.dims)
  }

  firstVector() {
    for (const map of [this.episodes, this.memories]) {
      for (const row of map.values()) if (row.vec) return row.vec
    }
    return undefined
  }

  /** Re-encode all stored rows with the current corpus statistics. */
  reindex() {
    const started = Date.now()
    let count = 0
    for (const kind of ['episode', 'memory']) {
      const map = kind === 'episode' ? this.episodes : this.memories
      let batch = []
      const flush = () => {
        if (batch.length === 0) return
        this.store.tx(() => this.store.updateVectors(kind, batch))
        for (const item of batch) {
          const row = map.get(item.id)
          if (row) {
            row.vec = item.vec
            row.vecScale = item.vecScale
          }
        }
        count += batch.length
        batch = []
      }
      for (const row of map.values()) {
        const { vec, vecScale } = this.encodeFor(kind, this.textOf(row))
        batch.push({ id: row.id, vec, vecScale })
        if (batch.length >= 500) flush()
      }
      flush()
    }
    this.store.setMeta('embed_dims', this.dims)
    console.log(`[dsh-memory] reindexed ${count} rows for dims=${this.dims} in ${Date.now() - started}ms`)
  }

  textOf(row) {
    return [row.title, row.action ?? row.summary, (row.flow ?? []).join(' '), (row.tags ?? []).join(' '), row.project ?? '']
      .filter(Boolean)
      .join('\n')
  }

  /** Embed one text with the corpus statistics of the target table. */
  encodeFor(kind, text) {
    const index = kind === 'episode' ? this.epIndex : this.memIndex
    const { blob, scale } = quantize(embed(tokenize(text), index.df, index.size, this.dims))
    return { vec: blob, vecScale: scale }
  }

  add(kind, row) {
    const map = kind === 'episode' ? this.episodes : this.memories
    const index = kind === 'episode' ? this.epIndex : this.memIndex
    // Writes hand us full rows (including content); the index must not retain it.
    // Newly written rows also lack the DB defaults (hits), so normalize them here.
    const stored = kind === 'memory'
      ? { ...row, content: undefined, contentBytes: undefined, hits: row.hits ?? 0 }
      : { ...row, hits: row.hits ?? 0 }
    map.set(stored.id, stored)
    index.add(stored.id, this.textOf(stored))
  }

  remove(kind, id) {
    const map = kind === 'episode' ? this.episodes : this.memories
    const index = kind === 'episode' ? this.epIndex : this.memIndex
    map.delete(id)
    index.remove(id)
  }

  markTrimmed(id) {
    const row = this.memories.get(id)
    if (row) {
      row.content = null
      row.contentState = 'trimmed'
    }
  }

  filter(kind, { project, since, until } = {}) {
    const map = kind === 'episode' ? this.episodes : this.memories
    const allowed = new Set()
    for (const row of map.values()) {
      if (project && row.project && row.project !== project) continue
      if (since && row.tsEnd < since) continue
      if (until && row.tsEnd > until) continue
      allowed.add(row.id)
    }
    return allowed
  }

  /** Hybrid ranking for one table: BM25 ∪ cosine, fused by RRF. */
  query(kind, text, filter, now = Date.now()) {
    const map = kind === 'episode' ? this.episodes : this.memories
    const index = kind === 'episode' ? this.epIndex : this.memIndex
    const allowed = this.filter(kind, filter)
    if (allowed.size === 0) return []

    const lexical = index.search(text, { allowed })
    const qvec = quantize(embed(tokenize(text), index.df, index.size, this.dims)).blob

    const vectorList = []
    let bestCosine = 0
    for (const id of allowed) {
      const row = map.get(id)
      if (!row?.vec) continue
      const score = cosine(qvec, row.vec)
      if (score > bestCosine) bestCosine = score
      if (score > 0) vectorList.push({ id, score })
    }
    vectorList.sort((a, b) => b.score - a.score)

    if (lexical.length === 0 && bestCosine < 0.12) return []

    const fused = rrf([lexical, vectorList])
    const ranked = []
    for (const [id, score] of fused) {
      const row = map.get(id)
      if (!row) continue
      const ageDays = Math.max(0, (now - row.tsEnd) / DAY)
      const boosted = score * (1 + this.recencyBoost * Math.exp(-ageDays / 30))
      ranked.push({ row, score: boosted })
    }
    ranked.sort((a, b) => b.score - a.score)
    return ranked
  }

  /** Episodes first; memories fill the remaining slots. */
  recall({ query, limit = 5, project, since, until, now = Date.now() }) {
    const filter = { project, since, until }
    const episodes = this.query('episode', query, filter, now).slice(0, limit)
    const covered = new Set()
    for (const hit of episodes) {
      for (const id of this.store.episodeMemoryIds(hit.row.id)) covered.add(id)
    }
    const need = limit - episodes.length
    const memories =
      need > 0
        ? this.query('memory', query, filter, now)
            .filter((hit) => !covered.has(hit.row.id))
            .slice(0, need)
        : []
    return { episodes, memories }
  }
}