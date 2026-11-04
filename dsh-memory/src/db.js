/** SQLite persistence for the local memory store. */

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const HITS_MAX = 2147483647

const SCHEMA = `
CREATE TABLE IF NOT EXISTS episodes (
  id            TEXT PRIMARY KEY,
  created_at    INTEGER NOT NULL,
  trigger       TEXT NOT NULL CHECK (trigger IN
                  ('idle_1h','context_pressure','max_tokens','session_end','explicit_save')),
  trigger_note  TEXT,
  session_id    TEXT,
  project       TEXT,
  cwd           TEXT,
  ts_start      INTEGER NOT NULL,
  ts_end        INTEGER NOT NULL,
  title         TEXT NOT NULL,
  action        TEXT NOT NULL,
  flow          TEXT,
  outcome       TEXT NOT NULL CHECK (outcome IN ('success','failure','partial')),
  outcome_note  TEXT,
  tags          TEXT,
  memory_count  INTEGER NOT NULL DEFAULT 0,
  hits          INTEGER NOT NULL DEFAULT 0,
  last_hit_at   INTEGER,
  bytes         INTEGER NOT NULL,
  vec           BLOB,
  vec_scale     REAL
);
CREATE INDEX IF NOT EXISTS idx_ep_created ON episodes(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ep_hits    ON episodes(hits, created_at);
CREATE INDEX IF NOT EXISTS idx_ep_project ON episodes(project, created_at DESC);

CREATE TABLE IF NOT EXISTS memories (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  turn          INTEGER,
  project       TEXT,
  cwd           TEXT,
  ts_start      INTEGER NOT NULL,
  ts_end        INTEGER NOT NULL,
  title         TEXT NOT NULL,
  summary       TEXT NOT NULL,
  flow          TEXT,
  outcome       TEXT NOT NULL CHECK (outcome IN ('success','failure','partial')),
  outcome_note  TEXT,
  tags          TEXT,
  content       TEXT,
  content_state TEXT NOT NULL DEFAULT 'full' CHECK (content_state IN ('full','trimmed','never')),
  trimmed_at    INTEGER,
  hits          INTEGER NOT NULL DEFAULT 0,
  last_hit_at   INTEGER,
  bytes         INTEGER NOT NULL,
  content_bytes INTEGER NOT NULL DEFAULT 0,
  vec           BLOB,
  vec_scale     REAL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mem_turn    ON memories(session_id, turn) WHERE turn IS NOT NULL;
CREATE INDEX        IF NOT EXISTS idx_mem_hits    ON memories(hits, ts_end);
CREATE INDEX        IF NOT EXISTS idx_mem_project ON memories(project, ts_end DESC);
CREATE INDEX        IF NOT EXISTS idx_mem_time    ON memories(ts_end DESC);

CREATE TABLE IF NOT EXISTS episode_memory (
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  memory_id  TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  linked_at  INTEGER NOT NULL,
  PRIMARY KEY (episode_id, memory_id)
);
CREATE INDEX IF NOT EXISTS idx_em_memory ON episode_memory(memory_id);

CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`

const EPISODE_COLUMNS = [
  'id', 'created_at', 'trigger', 'trigger_note', 'session_id', 'project', 'cwd',
  'ts_start', 'ts_end', 'title', 'action', 'flow', 'outcome', 'outcome_note',
  'tags', 'memory_count', 'bytes', 'vec', 'vec_scale',
]
const MEMORY_COLUMNS = [
  'id', 'session_id', 'turn', 'project', 'cwd', 'ts_start', 'ts_end', 'title',
  'summary', 'flow', 'outcome', 'outcome_note', 'tags', 'content',
  'content_state', 'bytes', 'content_bytes', 'vec', 'vec_scale',
]

function rowToEpisode(row) {
  if (!row) return undefined
  return {
    kind: 'episode',
    id: row.id,
    createdAt: row.created_at,
    trigger: row.trigger,
    triggerNote: row.trigger_note,
    sessionId: row.session_id,
    project: row.project,
    cwd: row.cwd,
    tsStart: row.ts_start,
    tsEnd: row.ts_end,
    title: row.title,
    action: row.action,
    flow: row.flow ? JSON.parse(row.flow) : [],
    outcome: row.outcome,
    outcomeNote: row.outcome_note,
    tags: row.tags ? JSON.parse(row.tags) : [],
    memoryCount: row.memory_count,
    hits: row.hits,
    lastHitAt: row.last_hit_at,
    bytes: row.bytes,
    vec: row.vec,
    vecScale: row.vec_scale,
  }
}

function rowToMemory(row) {
  if (!row) return undefined
  return {
    kind: 'memory',
    id: row.id,
    sessionId: row.session_id,
    turn: row.turn,
    project: row.project,
    cwd: row.cwd,
    tsStart: row.ts_start,
    tsEnd: row.ts_end,
    title: row.title,
    summary: row.summary,
    action: row.summary,
    flow: row.flow ? JSON.parse(row.flow) : [],
    outcome: row.outcome,
    outcomeNote: row.outcome_note,
    tags: row.tags ? JSON.parse(row.tags) : [],
    content: row.content,
    contentState: row.content_state,
    trimmedAt: row.trimmed_at,
    hits: row.hits,
    lastHitAt: row.last_hit_at,
    bytes: row.bytes,
    contentBytes: row.content_bytes,
    vec: row.vec,
    vecScale: row.vec_scale,
  }
}

export class Store {
  constructor(dbPath) {
    this.dbPath = dbPath
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new DatabaseSync(dbPath)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous  = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
    `)
    this.db.exec(SCHEMA)
    const version = this.db.prepare('PRAGMA user_version').get().user_version ?? 0
    if (version < 1) this.db.exec('PRAGMA user_version = 1')
  }

  close() {
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } catch {
      /* best effort */
    }
    this.db.close()
  }

  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const value = fn()
      this.db.exec('COMMIT')
      return value
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        /* already rolled back */
      }
      throw error
    }
  }

  // ---------------------------------------------------------------- meta

  getMeta(key, fallback = undefined) {
    const row = this.db.prepare('SELECT v FROM meta WHERE k = ?').get(key)
    if (!row) return fallback
    try {
      return JSON.parse(row.v)
    } catch {
      return row.v
    }
  }

  setMeta(key, value) {
    this.db
      .prepare('INSERT INTO meta(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
      .run(key, JSON.stringify(value))
  }

  // --------------------------------------------------------------- counts

  counts() {
    const episodes = this.db.prepare('SELECT COUNT(*) AS n FROM episodes').get().n
    const memories = this.db.prepare('SELECT COUNT(*) AS n FROM memories').get().n
    const bytes =
      this.db.prepare('SELECT COALESCE(SUM(bytes), 0) AS b FROM episodes').get().b +
      this.db.prepare('SELECT COALESCE(SUM(bytes), 0) AS b FROM memories').get().b +
      this.db.prepare('SELECT COALESCE(SUM(content_bytes), 0) AS b FROM memories').get().b
    return { episodes, memories, entries: episodes + memories, bytes }
  }

  // --------------------------------------------------------------- writes

  insertEpisode(episode) {
    const values = [
      episode.id, episode.createdAt, episode.trigger, episode.triggerNote ?? null,
      episode.sessionId ?? null, episode.project ?? null, episode.cwd ?? null,
      episode.tsStart, episode.tsEnd, episode.title, episode.action,
      JSON.stringify(episode.flow ?? []), episode.outcome, episode.outcomeNote ?? null,
      JSON.stringify(episode.tags ?? []), episode.memoryCount ?? 0,
      episode.bytes, episode.vec ?? null, episode.vecScale ?? null,
    ]
    this.db
      .prepare(`INSERT INTO episodes(${EPISODE_COLUMNS.join(',')}) VALUES (${EPISODE_COLUMNS.map(() => '?').join(',')})`)
      .run(...values)
  }

  insertMemory(memory) {
    const values = [
      memory.id, memory.sessionId, memory.turn ?? null, memory.project ?? null,
      memory.cwd ?? null, memory.tsStart, memory.tsEnd, memory.title, memory.summary,
      JSON.stringify(memory.flow ?? []), memory.outcome, memory.outcomeNote ?? null,
      JSON.stringify(memory.tags ?? []), memory.content ?? null,
      memory.contentState ?? 'full', memory.bytes, memory.contentBytes ?? 0,
      memory.vec ?? null, memory.vecScale ?? null,
    ]
    this.db
      .prepare(`INSERT INTO memories(${MEMORY_COLUMNS.join(',')}) VALUES (${MEMORY_COLUMNS.map(() => '?').join(',')})`)
      .run(...values)
  }

  linkEpisode(episodeId, memoryIds, now = Date.now()) {
    const stmt = this.db.prepare(
      'INSERT OR IGNORE INTO episode_memory(episode_id, memory_id, linked_at) VALUES (?, ?, ?)',
    )
    for (const id of memoryIds) stmt.run(episodeId, id, now)
    this.refreshMemoryCount(episodeId)
  }

  /** Recompute the cached link count (it is a cache, so every cascade delete must refresh it). */
  refreshMemoryCount(episodeId) {
    this.db
      .prepare('UPDATE episodes SET memory_count = (SELECT COUNT(*) FROM episode_memory WHERE episode_id = ?) WHERE id = ?')
      .run(episodeId, episodeId)
  }

  // ---------------------------------------------------------------- reads

  getEpisode(id) {
    return rowToEpisode(this.db.prepare('SELECT * FROM episodes WHERE id = ?').get(id))
  }

  getMemory(id) {
    return rowToMemory(this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id))
  }

  episodeMemoryIds(episodeId) {
    return this.db
      .prepare('SELECT memory_id FROM episode_memory WHERE episode_id = ? ORDER BY linked_at, memory_id')
      .all(episodeId)
      .map((r) => r.memory_id)
  }

  memoryLinkCount(memoryId) {
    return this.db.prepare('SELECT COUNT(*) AS n FROM episode_memory WHERE memory_id = ?').get(memoryId).n
  }

  /** Explicit saves created during one turn, so a reload can re-attach them. */
  episodesSince(sessionId, since) {
    return this.db
      .prepare(
        `SELECT id FROM episodes
          WHERE session_id = ? AND trigger = 'explicit_save' AND created_at >= ?
          ORDER BY created_at`,
      )
      .all(sessionId, since)
      .map((r) => r.id)
  }

  /** Memories of one session that no episode has summarized yet. */
  unlinkedMemories(sessionId, cutoff = Number.POSITIVE_INFINITY) {
    return this.db
      .prepare(
        `SELECT m.* FROM memories m
           LEFT JOIN episode_memory em ON em.memory_id = m.id
          WHERE m.session_id = ? AND em.memory_id IS NULL AND m.ts_end <= ?
          ORDER BY m.ts_start ASC`,
      )
      .all(sessionId, cutoff)
      .map(rowToMemory)
  }

  allEpisodes() {
    return this.db.prepare('SELECT * FROM episodes ORDER BY created_at DESC').all().map(rowToEpisode)
  }

  allMemories() {
    return this.db.prepare('SELECT * FROM memories ORDER BY ts_end DESC').all().map(rowToMemory)
  }

  /** Search-facing projection: metadata + vector, never the transcript. */
  indexMemories() {
    return this.db
      .prepare(
        `SELECT id, session_id, turn, project, cwd, ts_start, ts_end, title, summary,
                flow, outcome, outcome_note, tags, hits, last_hit_at, bytes,
                content_state, vec, vec_scale
           FROM memories ORDER BY ts_end DESC`,
      )
      .all()
      .map(rowToMemory)
  }

  // ----------------------------------------------------------------- hits

  updateVectors(kind, items) {
    const table = kind === 'episode' ? 'episodes' : 'memories'
    const stmt = this.db.prepare(`UPDATE ${table} SET vec = ?, vec_scale = ? WHERE id = ?`)
    for (const item of items) stmt.run(item.vec, item.vecScale, item.id)
  }

  bumpHits(kind, ids, now = Date.now()) {
    const table = kind === 'episode' ? 'episodes' : 'memories'
    const stmt = this.db.prepare(
      `UPDATE ${table} SET hits = MIN(hits + 1, ${HITS_MAX}), last_hit_at = ? WHERE id = ?`,
    )
    for (const id of ids) stmt.run(now, id)
  }

  // ------------------------------------------------------------- eviction

  /**
   * Eviction candidates, least-used and oldest first, never inside the grace window.
   * `cutoff` is the newest timestamp still eligible for eviction.
   */
  candidates(limit, cutoff = Number.MAX_SAFE_INTEGER) {
    if (limit <= 0) return []
    return this.db
      .prepare(
        `SELECT id, kind, hits, at FROM (
           SELECT id, 'episode' AS kind, hits, created_at AS at
             FROM episodes WHERE created_at <= ?
           UNION ALL
           SELECT id, 'memory' AS kind, hits, ts_end AS at
             FROM memories WHERE ts_end <= ?
         )
         ORDER BY hits ASC, at ASC, id ASC
         LIMIT ?`,
      )
      .all(cutoff, cutoff, limit)
  }

  /** How many rows may enter the eviction queue at `cutoff`. */
  evictableCount(cutoff = Number.MAX_SAFE_INTEGER) {
    return this.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM episodes WHERE created_at <= ?) +
           (SELECT COUNT(*) FROM memories WHERE ts_end <= ?) AS eligible,
           (SELECT COUNT(*) FROM episodes) +
           (SELECT COUNT(*) FROM memories) AS total`,
      )
      .get(cutoff, cutoff)
  }

  deleteEpisode(id) {
    const memoryIds = this.episodeMemoryIds(id)
    this.db.prepare('DELETE FROM episodes WHERE id = ?').run(id)
    return memoryIds
  }

  /** Drop the transcript but keep the summary row. Returns bytes freed. */
  trimMemory(id, now = Date.now()) {
    const row = this.db
      .prepare("SELECT content_bytes FROM memories WHERE id = ? AND content_state = 'full'")
      .get(id)
    if (!row) return 0
    this.db
      .prepare(
        "UPDATE memories SET content = NULL, content_state = 'trimmed', trimmed_at = ?, content_bytes = 0 WHERE id = ?",
      )
      .run(now, id)
    return row.content_bytes
  }

  deleteMemory(id) {
    const episodeIds = this.db
      .prepare('SELECT episode_id FROM episode_memory WHERE memory_id = ?')
      .all(id)
      .map((row) => row.episode_id)
    this.db.prepare('DELETE FROM memories WHERE id = ?').run(id)
    // The FK cascade drops the links; the cached counts must follow.
    for (const episodeId of episodeIds) this.refreshMemoryCount(episodeId)
    return episodeIds
  }
}