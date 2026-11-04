/** Lexical ranking (BM25) and reciprocal-rank fusion for the memory store. */

import { tokenize } from './vector.js'

const K1 = 1.2
const B = 0.75

export class Bm25Index {
  constructor() {
    /** @type {Map<string, {tf: Map<string, number>, len: number}>} */
    this.docs = new Map()
    /** @type {Map<string, number>} */
    this.df = new Map()
    this.totalLen = 0
  }

  get size() {
    return this.docs.size
  }

  /** Add or replace one document. */
  add(id, text) {
    this.remove(id)
    const tokens = tokenize(text)
    if (tokens.length === 0) {
      this.docs.set(id, { tf: new Map(), len: 0 })
      return
    }
    const tf = new Map()
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1)
    for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1)
    this.docs.set(id, { tf, len: tokens.length })
    this.totalLen += tokens.length
  }

  remove(id) {
    const doc = this.docs.get(id)
    if (!doc) return
    for (const t of doc.tf.keys()) {
      const next = (this.df.get(t) ?? 0) - 1
      if (next <= 0) this.df.delete(t)
      else this.df.set(t, next)
    }
    this.totalLen -= doc.len
    this.docs.delete(id)
  }

  /** BM25 scores for the query, highest first. */
  search(query, { allowed } = {}) {
    const terms = tokenize(query)
    if (terms.length === 0 || this.docs.size === 0) return []
    const unique = [...new Set(terms)]
    const avgdl = this.totalLen / Math.max(1, this.docs.size)
    const out = []
    for (const [id, doc] of this.docs) {
      if (allowed && !allowed.has(id)) continue
      let score = 0
      for (const term of unique) {
        const f = doc.tf.get(term)
        if (!f) continue
        const dfv = this.df.get(term) ?? 0
        const idf = Math.log(1 + (this.docs.size - dfv + 0.5) / (dfv + 0.5))
        const denom = f + K1 * (1 - B + (B * doc.len) / Math.max(1, avgdl))
        score += idf * ((f * (K1 + 1)) / denom)
      }
      if (score > 0) out.push({ id, score })
    }
    out.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
    return out
  }
}

/** Reciprocal rank fusion: score = Σ 1/(k + rank). */
export function rrf(lists, k = 60) {
  const fused = new Map()
  for (const list of lists) {
    list.forEach((item, index) => {
      fused.set(item.id, (fused.get(item.id) ?? 0) + 1 / (k + index + 1))
    })
  }
  return fused
}

/** Rough token count for budgeting: CJK counts ~1 per char, latin ~1 per 4. */
export function estimateTokens(text) {
  if (!text) return 0
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (/[\u3400-\u9fff\uf900-\ufaff]/.test(ch)) cjk++
    else other++
  }
  return cjk + Math.ceil(other / 4)
}

/** Cut a card list down to a token budget, always keeping at least one item. */
export function withinBudget(items, maxTokens, textOf) {
  const kept = []
  let used = 0
  for (const item of items) {
    const cost = estimateTokens(textOf(item))
    if (kept.length > 0 && used + cost > maxTokens) break
    kept.push(item)
    used += cost
  }
  return { items: kept, tokens: used, truncated: kept.length < items.length }
}