/**
 * Offline embeddings: signed feature hashing over latin tokens and CJK
 * bigrams, weighted by inverse document frequency, L2-normalised and
 * quantised to int8. No network, no model, deterministic.
 */

const LATIN = /[a-z0-9_./\\-]+/g
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g

/** Split one latin token into its parts (snake/kebab/path/camel). */
function latinParts(token) {
  const parts = new Set([token])
  for (const piece of token.split(/[._/\\-]+/)) {
    if (piece.length >= 2) parts.add(piece)
  }
  const camel = token.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()
  for (const piece of camel.split(/\s+/)) {
    if (piece.length >= 2) parts.add(piece)
  }
  return parts
}

/** Tokenise mixed Chinese/English text into indexable terms. */
export function tokenize(text) {
  if (!text) return []
  const lower = String(text).toLowerCase()
  const out = []

  LATIN.lastIndex = 0
  let m
  while ((m = LATIN.exec(lower)) !== null) {
    const token = m[0]
    if (token.length < 2) continue
    for (const part of latinParts(token)) out.push(part)
  }

  CJK.lastIndex = 0
  while ((m = CJK.exec(lower)) !== null) {
    const run = m[0]
    if (run.length === 1) {
      out.push(run)
      continue
    }
    for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2))
    for (let i = 0; i + 2 < run.length; i++) out.push(run.slice(i, i + 3))
  }

  return out
}

/** FNV-1a 32-bit over the token's code units. */
export function hashToken(token) {
  let h = 0x811c9dc5
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** Term weights from the current corpus: ln(1 + N / df). */
export function weightsOf(tokens, df, docCount) {
  const tf = new Map()
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1)
  const weights = new Map()
  const n = Math.max(1, docCount)
  for (const [token, count] of tf) {
    const dfv = df.get(token) ?? 0
    const idf = Math.log(1 + n / (1 + dfv))
    weights.set(token, (1 + Math.log(count)) * idf)
  }
  return weights
}

/** Signed feature hashing into `dims` buckets, then L2 normalisation. */
export function embed(tokens, df, docCount, dims = 384) {
  const vec = new Float32Array(dims)
  const weights = weightsOf(tokens, df, docCount)
  for (const [token, weight] of weights) {
    const h = hashToken(token)
    const idx = h % dims
    const sign = (h >>> 16) & 1 ? -1 : 1
    vec[idx] += sign * weight
  }
  let norm = 0
  for (let i = 0; i < dims; i++) norm += vec[i] * vec[i]
  norm = Math.sqrt(norm)
  if (norm === 0) return vec
  for (let i = 0; i < dims; i++) vec[i] /= norm
  return vec
}

/** Quantise a normalised float vector to int8 plus its scale. */
export function quantize(vec) {
  let max = 0
  for (let i = 0; i < vec.length; i++) {
    const abs = Math.abs(vec[i])
    if (abs > max) max = abs
  }
  const scale = max === 0 ? 1 : max / 127
  const blob = new Uint8Array(vec.length)
  for (let i = 0; i < vec.length; i++) {
    const q = Math.max(-127, Math.min(127, Math.round(vec[i] / scale)))
    blob[i] = q < 0 ? q + 256 : q
  }
  return { blob, scale }
}

/** Reinterpret an unsigned BLOB as signed int8 values. */
export function signed(blob) {
  const out = new Int8Array(blob.length)
  for (let i = 0; i < blob.length; i++) out[i] = blob[i] > 127 ? blob[i] - 256 : blob[i]
  return out
}

/** Cosine similarity of two quantised vectors (per-vector scale cancels out). */
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i] > 127 ? a[i] - 256 : a[i]
    const y = b[i] > 127 ? b[i] - 256 : b[i]
    dot += x * y
    na += x * x
    nb += y * y
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/** Embed + quantise one document in a single call. */
export function encode(text, df, docCount, dims = 384) {
  return quantize(embed(tokenize(text), df, docCount, dims))
}