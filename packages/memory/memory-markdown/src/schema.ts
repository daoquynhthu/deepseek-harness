/**
 * SQLite schema for the memory chunk index.
 *
 * The index stores chunked text from memory files: a `chunks` table for
 * structured metadata and a contentless FTS5 virtual table for BM25 keyword
 * search. The optional `chunks_vec` vec0 table for vector similarity is a
 * deferred follow-up; FTS-only operation never imports the vector extension.
 *
 * @module @deepseek-ai/dsh-memory-markdown
 */

import type { DatabaseSync } from 'node:sqlite'
import { mkdir, open } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

/** Current memory-index schema version. Incompatible versions reset in place. */
export const MEMORY_SQLITE_SCHEMA_VERSION = 1

/** SQLite application id protecting unrelated databases from derived resets. */
export const MEMORY_SQLITE_APPLICATION_ID = 0x4d454d31

/** Supported SQLite journal modes. */
export type JournalMode = 'wal' | 'delete' | 'truncate' | 'persist'

/** Memory-owned tables for derived-schema validation. */
const MEMORY_USER_TABLES = new Set([
  'chunks',
  'chunks_fts',
  'chunks_fts_data',
  'chunks_fts_idx',
  'chunks_fts_content',
  'chunks_fts_docsize',
  'chunks_fts_config',
  'chunks_vec',
])

/* jscpd:ignore-start -- deliberately mirrors the session-persistence-sqlite /
   session-query-sqlite open/validate sequence; memory is the fourth derived-index
   user, and the shared medium helper is deferred to the derived-index extraction
   so the session and storage packages stay untouched this phase (see the
   cross-session memory Agent Note's reuse audit). */
/**
 * Exclusively create a missing database file with owner-only permissions.
 * Existing files retain their modes, and errors other than `EEXIST` propagate.
 */
async function createDatabaseFile(path: string): Promise<void> {
  try {
    const handle = await open(path, 'wx', 0o600)
    await handle.close()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

/**
 * Open, validate, and initialize the memory chunk index.
 * @param path - dedicated index path or `:memory:`; missing filesystem paths are created owner-only.
 * @param journalMode - validated SQLite journal mode.
 * @returns initialized database handle owned by the memory provider.
 */
export async function openMemoryDatabase(path: string, journalMode: JournalMode): Promise<DatabaseSync> {
  const actual = path === ':memory:' ? path : resolve(path)
  if (actual !== ':memory:') {
    await mkdir(dirname(actual), { recursive: true, mode: 0o700 })
    await createDatabaseFile(actual)
  }
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(actual)
  try {
    const { application_id: applicationId } = db.prepare('PRAGMA application_id').get() as { application_id: number }
    const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number }
    const userTables = listUserTables(db)
    if (applicationId !== 0 && applicationId !== MEMORY_SQLITE_APPLICATION_ID) {
      throw new Error(`memory index at "${actual}" belongs to another application`)
    }
    if (applicationId === 0 && userTables.length > 0) {
      throw new Error(`memory index at "${actual}" is not an empty or recognized derived index`)
    }
    if (applicationId === MEMORY_SQLITE_APPLICATION_ID) {
      assertDerivedUserTables(actual, userTables)
      if (version !== MEMORY_SQLITE_SCHEMA_VERSION) resetDerivedSchema(db, userTables)
    }
    db.exec(`PRAGMA journal_mode = ${journalMode.toUpperCase()}`)
    ensureSchema(db)
    return db
  } catch (error: unknown) {
    db.close()
    throw error
  }
}

function listUserTables(db: DatabaseSync): string[] {
  const rows = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' ORDER BY name",
  ).all() as Array<{ name: string }>
  return rows.map(row => row.name)
}

function assertDerivedUserTables(path: string, userTables: readonly string[]): void {
  const unknownTables = userTables.filter(name => !MEMORY_USER_TABLES.has(name))
  if (unknownTables.length > 0) {
    throw new Error(
      `memory index at "${path}" has unrecognized user tables: ${unknownTables.join(', ')}`,
    )
  }
}

function resetDerivedSchema(db: DatabaseSync, userTables: readonly string[]): void {
  for (const name of userTables) {
    db.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(name)}`)
  }
  db.exec('PRAGMA user_version = 0')
}
/* jscpd:ignore-end */

function ensureSchema(db: DatabaseSync): void {
  db.exec(`PRAGMA application_id = ${MEMORY_SQLITE_APPLICATION_ID}`)
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id           TEXT PRIMARY KEY,
      path         TEXT NOT NULL,
      start_line   INTEGER NOT NULL,
      end_line     INTEGER NOT NULL,
      text         TEXT NOT NULL,
      source       TEXT NOT NULL,
      access_count INTEGER NOT NULL,
      created_at   INTEGER NOT NULL
    ) STRICT
  `)
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      text,
      id UNINDEXED,
      source UNINDEXED,
      tokenize = 'unicode61'
    )
  `)
  db.exec(`PRAGMA user_version = ${MEMORY_SQLITE_SCHEMA_VERSION}`)
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}
