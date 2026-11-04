/** Append-only human-readable archive of transcripts written before summarizing. */

import { appendFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fmtTime } from './summarize.js'

function stamp(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export class Journal {
  constructor({ dir, maxBytes = 512 * 1024 * 1024 }) {
    this.dir = dir
    this.maxBytes = maxBytes
    mkdirSync(dir, { recursive: true })
  }

  /** Reserve the next file for the day, rotating when the size cap is hit. */
  fileFor(day, index) {
    return join(this.dir, index === 1 ? `${day}.md` : `${day}-${index}.md`)
  }

  append({ trigger, sessionId, project, start, end, blocks }) {
    const day = stamp(start)
    let index = 1
    let file = this.fileFor(day, index)
    while (existsSync(file) && statSync(file).size >= this.maxBytes && index < 1000) {
      index += 1
      file = this.fileFor(day, index)
    }

    const head = `## ${fmtTime(start)} – ${fmtTime(end)} · session ${sessionId} · ${project ?? 'global'} · trigger=${trigger}\n\n`
    const body = blocks.join('\n\n')
    appendFileSync(file, `${head}${body}\n\n---\n\n`, 'utf8')
    return file
  }
}