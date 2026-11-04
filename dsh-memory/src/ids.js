/** Stable, sortable-enough identifiers. No external dependency. */
import { randomBytes } from 'node:crypto'

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

function base36(n, width = 0) {
  let out = ''
  let v = Math.max(0, Math.floor(n))
  do {
    out = ALPHABET[v % 36] + out
    v = Math.floor(v / 36)
  } while (v > 0)
  return out.padStart(width, '0')
}

function suffix(bytes = 5) {
  return randomBytes(bytes).toString('hex')
}

/** Epoch-ms prefix keeps ids roughly chronological for human inspection. */
export function newMemoryId(now = Date.now()) {
  return `mem_${base36(now, 9)}${suffix()}`
}

export function newEpisodeId(now = Date.now()) {
  return `ep_${base36(now, 9)}${suffix()}`
}