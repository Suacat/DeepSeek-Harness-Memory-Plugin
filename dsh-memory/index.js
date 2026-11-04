/** Local-first memory store for DeepSeek Harness. */

import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { Capture } from './src/capture.js'
import { defaultDataDir, resolveConfig } from './src/config.js'
import { Store } from './src/db.js'
import { Writer } from './src/evict.js'
import { Journal } from './src/journal.js'
import { Search } from './src/search.js'
import { registerTools } from './src/tools.js'

export const name = 'dsh-memory'

export const inject = ['tools', 'systemPrompt']

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  if (!config.enabled) return

  const dataDir = config.dataDir || defaultDataDir()
  const store = new Store(join(dataDir, 'engram.db'))
  const search = new Search(store, { dims: config.embedDims, recencyBoost: config.recencyBoost })
  search.rebuild()

  const journal = new Journal({ dir: join(dataDir, 'journal'), maxBytes: config.journalMaxBytes })
  const writer = new Writer({
    store,
    index: search,
    config,
    auditPath: join(dataDir, 'log', 'maintenance.jsonl'),
  })

  const pressureOf = (session) => {
    try {
      const meter = ctx.get('tokenMeter')
      if (!meter) return null
      const contextWindow = session.requestContext?.()?.contextWindow
      if (!contextWindow) return null
      const total = meter.measure(session)?.totalTokens ?? 0
      if (!total) return null
      return { ratio: total / contextWindow, tokens: total }
    } catch {
      return null
    }
  }

  const capture = new Capture({ store, writer, search, journal, config, pressureOf })

  // A reload must not split one task into two episodes: replay the in-flight
  // turn of every live session and re-attach the saves it already produced.
  let resumed = 0
  let idled = 0
  try {
    for (const session of ctx.get('sessions')?.list?.() ?? []) {
      try {
        if (capture.resume(session)) resumed += 1
      } catch (error) {
        console.error(`[dsh-memory] resume failed: ${error?.message ?? error}`)
      }
      try {
        if (capture.reconcileIdle(session)) idled += 1
      } catch (error) {
        console.error(`[dsh-memory] idle reconcile failed: ${error?.message ?? error}`)
      }
    }
  } catch (error) {
    console.error(`[dsh-memory] resume scan failed: ${error?.message ?? error}`)
  }

  try {
    appendFileSync(
      join(dataDir, 'log', 'plugin.log'),
      `${new Date().toISOString()} config=${JSON.stringify({
        capacity: config.capacityBytes,
        budget: config.recallTokenBudget,
        journalMax: config.journalMaxBytes,
        dims: config.embedDims,
        gap: config.gapMinutes,
      })} resume scanned=${resumed} idle-closed=${idled} ${JSON.stringify(capture.resumeLog ?? [])}\n`,
      'utf8',
    )
  } catch {
    /* diagnostics must never break activation */
  }

  ctx.effect(() => () => {
    capture.disposeAll()
    store.close()
  })

  ctx.on('session/event', (session, event) => {
    try {
      capture.observe(session, event)
    } catch (error) {
      console.error(`[dsh-memory] capture failed: ${error?.message ?? error}`)
    }
  })

  ctx.on('session/disposed', (session) => {
    try {
      capture.dispose(session)
    } catch (error) {
      console.error(`[dsh-memory] dispose failed: ${error?.message ?? error}`)
    }
  })

  registerTools({ ctx, store, search, writer, capture, config })

  console.log(
    `[dsh-memory] ready · db=${store.dbPath} · entries=${store.counts().entries} · ` +
    `capacity=${config.capacityBytes} · budget=${config.recallTokenBudget} · ` +
    `journalMax=${config.journalMaxBytes} · dims=${config.embedDims} · ` +
    `gap=${config.gapMinutes} · resumed=${resumed} · idle-closed=${idled}`,
  )
}