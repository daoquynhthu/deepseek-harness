/**
 * Markdown-backed cross-session memory provider.
 *
 * Stores curated knowledge as editable markdown under the harness home,
 * indexes chunks with SQLite FTS5, and serves hybrid search through the
 * `ctx.memory` service. Vector retrieval is opt-in: without an embedding
 * provider the search path stays FTS-only with zero LLM or embedding calls.
 *
 * @module @deepseek-ai/dsh-memory-markdown
 */

import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  MemoryError,
  MemoryPath,
  MemoryService,
  chunkMarkdown,
  assertNotAborted,
  isContentFree,
  resolveSearchLimits,
  type Config as MemoryConfig,
  type MemoryChunk,
  type MemoryChunkId,
  type MemoryFile,
  type MemoryInjectRequest,
  type MemoryPath as MemoryPathValue,
  type MemoryScope,
  type MemorySearchPage,
  type MemorySearchRequest,
  type MemorySearchResult,
  type ChunkConfig,
} from '@deepseek-ai/dsh-memory'
import {
  MEMORY_DEFAULT_MAX_CHUNK_CHARS,
  MEMORY_DEFAULT_CHUNK_OVERLAP_CHARS,
  absolutePath,
  ensureMemoryDirectories,
  pathScope,
  readMemoryFile,
  resolveMemoryLayout,
  writeMemoryFile,
  type MemoryLayout,
} from './layout.ts'
import { keywordScan, makeSnippet, rowToChunk, scoreRow, extractKeywords, type IndexedChunkRow } from './query.ts'
import { openMemoryDatabase, type JournalMode } from './schema.ts'

export {
  MEMORY_SQLITE_SCHEMA_VERSION,
  MEMORY_SQLITE_APPLICATION_ID,
  type JournalMode,
} from './schema.ts'
export {
  resolveMemoryLayout,
  workspaceHashOf,
  MEMORY_ROOT_DIR,
  type MemoryLayout,
} from './layout.ts'
export { extractKeywords, keywordScan } from './query.ts'

/** Default journal mode for the memory index. */
export const MEMORY_MARKDOWN_DEFAULT_JOURNAL = 'wal'

/** Open-phase for the SQLite memory index. */
export type MemoryOpenAt = 'startup' | 'first-search' | 'never'

/** Markdown memory provider configuration. */
export interface Config extends MemoryConfig {
  /** Index and chunk configuration. */
  index?: {
    /** Maximum chunk size in characters. Defaults to 800. */
    maxChunkChars?: number
    /** Overlap in characters between continuation chunks. Defaults to 120. */
    chunkOverlapChars?: number
  }
  /** Open the SQLite module and handle at activation or the first search, or `never`. */
  openAt?: MemoryOpenAt
  /** SQLite journal mode. Defaults to `wal`. */
  journalMode?: JournalMode
  /** Explicit memory root; defaults to `{dshHome}/memory`. */
  root?: string
  /** Workspace path used to derive the workspace memory directory. */
  workspace?: string
  /** Explicit harness home override passed to `resolveDshHome`. */
  dshHome?: string
  /** Memory index database path; defaults to `{root}/index.sqlite`. */
  path?: string
}

interface ResolvedConfig {
  maxChunkChars: number
  chunkOverlapChars: number
  openAt: MemoryOpenAt
  journalMode: JournalMode
  root: string
  workspace: string
  dshHome: string | undefined
  path: string
}

/** In-memory file cache keyed by absolute path. */
interface FileState {
  readonly path: MemoryPathValue
  readonly absolute: string
  readonly content: string
}

/** Concrete markdown memory owner of `ctx.memory`. */
export class MarkdownMemoryService extends MemoryService {
  static override inject = []

  static Config: z<Config> = z.object({
    maxResults: z.number().step(1).min(1),
    minScore: z.number().min(0).max(1),
    textWeight: z.number().min(0),
    vectorWeight: z.number().min(0),
    mmrEnabled: z.boolean(),
    temporalDecayEnabled: z.boolean(),
    halfLifeDays: z.number().min(0.000001),
    sourceWeights: z.object({}),
    index: z.object({
      maxChunkChars: z.number().step(1).min(1),
      chunkOverlapChars: z.number().step(1).min(0),
    }),
    openAt: z.union(['startup', 'first-search', 'never'] as const).default('startup'),
    journalMode: z.union(['wal', 'delete', 'truncate', 'persist'] as const).default(MEMORY_MARKDOWN_DEFAULT_JOURNAL),
    root: z.string(),
    workspace: z.string().required(),
    dshHome: z.string(),
    path: z.string(),
  })

  private readonly _resolved: ResolvedConfig
  private readonly _layout: MemoryLayout
  private readonly _chunkConfig: ChunkConfig
  private _db: DatabaseSync | undefined
  private _ready: Promise<void> | undefined
  private _closed = false
  private readonly _files = new Map<string, FileState>()

  constructor(ctx: Context, config: Config) {
    super(ctx, config)
    this._resolved = resolveConfig(config)
    this._layout = resolveMemoryLayout(
      this._resolved.workspace,
      this._resolved.root,
      this._resolved.dshHome,
    )
    this._chunkConfig = Object.freeze({
      maxChunkChars: this._resolved.maxChunkChars,
      chunkOverlapChars: this._resolved.chunkOverlapChars,
    })
    ctx.effect(() => async () => this.close(), 'memoryMarkdown.close')
  }

  /** Open eagerly only when activation owns the configured readiness boundary. */
  protected async [Service.init](): Promise<void> {
    if (this._resolved.openAt === 'startup') await this._ensureReady()
  }

  /** Close the database after the provider is disposed. */
  close(): Promise<void> {
    if (this._closed) return Promise.resolve()
    this._closed = true
    const db = this._db
    this._db = undefined
    db?.close()
    return Promise.resolve()
  }

  override async search(request: MemorySearchRequest): Promise<MemorySearchPage> {
    const limits = resolveSearchLimits(this, request)
    assertNotAborted(request.signal)
    this._assertSearchEnabled()
    await this._ensureReady()
    assertNotAborted(request.signal)
    const db = this._requireDb()
    const keywords = extractKeywords(request.query)
    const scanned = keywordScan(db, keywords, request.scope, limits.limit)
    const now = Date.now()
    const rows = scanned.rows
    const candidates: Array<{ chunk: MemoryChunk; base: number }> = []
    for (const [index, row] of rows.entries()) {
      const base = 1 - index / Math.max(1, rows.length)
      const chunk = rowToChunk(row)
      candidates.push({ chunk, base })
    }
    const results: MemorySearchResult[] = []
    for (const { chunk, base } of candidates) {
      const score = scoreRow(rowOf(chunk), base, now, this.config.search, this.config.sourceWeights)
      if (score < limits.minScore) continue
      results.push({
        chunk,
        score,
        snippet: makeSnippet(chunk.text),
        mode: 'fts-only',
      })
    }
    const bounded = results.slice(0, limits.limit)
    if (bounded.length > 0) this._bumpAccess(bounded)
    return {
      results: bounded,
      total: scanned.total,
    }
  }

  override async read(path: MemoryPathValue): Promise<string> {
    const state = await this._loadFile(path)
    return state.content
  }

  override async write(path: MemoryPathValue, content: string): Promise<void> {
    const absolute = absolutePath(this._layout, path)
    await writeMemoryFile(absolute, content)
    const state: FileState = { path, absolute, content }
    this._files.set(absolute, state)
    this._reindex(absolute)
  }

  override async list(): Promise<readonly MemoryFile[]> {
    await ensureMemoryDirectories(this._layout)
    const files: MemoryFile[] = []
    await this._collectFiles(this._layout.globalDir, 'global', files)
    await this._collectFiles(this._layout.workspaceDir, 'workspace', files)
    await this._collectSessionFiles(files)
    return files.sort((left, right) => left.path.localeCompare(right.path))
  }

  override async readChunks(path: MemoryPathValue): Promise<readonly MemoryChunk[]> {
    const state = await this._loadFile(path)
    return this._chunksOf(state)
  }

  override async inject(request: MemoryInjectRequest): Promise<readonly MemoryChunk[]> {
    if (!Number.isSafeInteger(request.maxChunks) || request.maxChunks < 1) {
      throw new MemoryError(
        'memory: maxChunks must be a positive safe integer',
        'MEMORY_INVALID_CONFIG',
      )
    }
    assertNotAborted(request.signal)
    this._assertSearchEnabled()
    await this._ensureReady()
    assertNotAborted(request.signal)
    const db = this._requireDb()
    const rows = db.prepare(`
      SELECT id, path, start_line, end_line, text, source, access_count, created_at
      FROM chunks
      WHERE source IN ('global', 'workspace')
      ORDER BY access_count DESC, created_at DESC
      LIMIT ?
    `).all(request.maxChunks) as unknown as IndexedChunkRow[]
    return rows.map(rowToChunk).filter(chunk => !isContentFree(chunk.text, chunk.source))
  }

  private async _loadFile(path: MemoryPathValue): Promise<FileState> {
    const absolute = absolutePath(this._layout, path)
    const cached = this._files.get(absolute)
    if (cached !== undefined) return cached
    const content = await readMemoryFile(absolute)
    const state: FileState = { path, absolute, content }
    this._files.set(absolute, state)
    return state
  }

  private async _ensureReady(): Promise<void> {
    this._ready ??= this._open()
    try {
      await this._ready
    } catch (error: unknown) {
      throw new MemoryError(
        `memory SQLite index failed to open: ${errorMessage(error)}`,
        'MEMORY_INVALID_CONFIG',
        { cause: error },
      )
    }
  }

  private async _open(): Promise<void> {
    await ensureMemoryDirectories(this._layout)
    this._db = await openMemoryDatabase(this._resolved.path, this._resolved.journalMode)
    await this._indexKnownFiles()
  }

  private _assertSearchEnabled(): void {
    if (this._resolved.openAt === 'never') {
      throw new MemoryError(
        'memory search is disabled: this deployment configures the memory index with openAt "never"',
        'MEMORY_INVALID_CONFIG',
      )
    }
  }

  private _requireDb(): DatabaseSync {
    /* v8 ignore next -- callers await `_ready`; this guards lifecycle misuse */
    if (this._db === undefined) throw new MemoryError('memory index is closed', 'MEMORY_INVALID_CONFIG')
    return this._db
  }

  private async _indexKnownFiles(): Promise<void> {
    await ensureMemoryDirectories(this._layout)
    for (const absolute of this._files.keys()) this._reindex(absolute)
    const known = new Set<string>()
    await this._scanDirectory(this._layout.globalDir, 'global', known)
    await this._scanDirectory(this._layout.workspaceDir, 'workspace', known)
    await this._scanSessionDirectory(known)
    this._purgeMissing(known)
  }

  private async _scanSessionDirectory(known: Set<string>): Promise<void> {
    for (const { name, absolute } of await this._listSessionArchives()) {
      known.add(absolute)
      try {
        await this._loadFile(MemoryPath('session', 'sessions', name))
      } catch {
        /* v8 ignore next -- a listed file can only fail to load through an I/O race */
        continue
      }
      this._reindex(absolute)
    }
  }

  /** List the `.md` session-archive files under the sessions directory. */
  private async _listSessionArchives(): Promise<Array<{ name: string; absolute: string }>> {
    let entries
    try {
      entries = await readdir(this._layout.sessionsDir, { withFileTypes: true })
    } catch {
      /* v8 ignore next -- callers create sessionsDir before listing, so readdir cannot fail here */
      return []
    }
    const archives: Array<{ name: string; absolute: string }> = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue
      try {
        MemoryPath('session', 'sessions', entry.name)
      } catch {
        continue
      }
      archives.push({ name: entry.name, absolute: join(this._layout.sessionsDir, entry.name) })
    }
    return archives
  }

  private async _scanDirectory(
    directory: string,
    scope: MemoryScope,
    known: Set<string>,
  ): Promise<void> {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      /* v8 ignore next -- _open creates both scan roots before indexing */
      return
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue
      let path: MemoryPathValue
      try {
        path = MemoryPath(scope, entry.name)
      } catch {
        continue
      }
      const absolute = join(directory, entry.name)
      known.add(absolute)
      try {
        await this._loadFile(path)
      } catch {
        /* v8 ignore next -- a listed file can only fail to load through an I/O race */
        continue
      }
      this._reindex(absolute)
    }
  }

  /** Drop index rows for files that no longer exist on disk. */
  private _purgeMissing(known: ReadonlySet<string>): void {
    const db = this._db
    /* v8 ignore next -- purge runs only from _indexKnownFiles after _open has opened the database */
    if (db === undefined) return
    const rows = db.prepare('SELECT DISTINCT path FROM chunks').all() as Array<{ path: string }>
    for (const row of rows) {
      if (known.has(row.path)) continue
      db.prepare('DELETE FROM chunks_fts WHERE id IN (SELECT id FROM chunks WHERE path = ?)').run(row.path)
      db.prepare('DELETE FROM chunks WHERE path = ?').run(row.path)
    }
  }

  private _reindex(absolute: string): void {
    const db = this._db
    if (db === undefined) return
    const state = this._files.get(absolute)
    /* v8 ignore next -- every _reindex call site loads or caches the state first */
    if (state === undefined) return
    const scope = pathScope(state.path)
    db.prepare('DELETE FROM chunks_fts WHERE id IN (SELECT id FROM chunks WHERE path = ?)').run(absolute)
    db.prepare('DELETE FROM chunks WHERE path = ?').run(absolute)
    const createdAt = Date.now()
    const chunks = chunkMarkdown(state.content, this._chunkConfig)
    const insert = db.prepare(`
      INSERT INTO chunks (id, path, start_line, end_line, text, source, access_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?)
    `)
    const insertFts = db.prepare(`
      INSERT INTO chunks_fts (text, id, source)
      VALUES (?, ?, ?)
    `)
    for (const chunk of chunks) {
      const id = chunkHashOf(chunk.text)
      const text = chunk.text
      insert.run(id, absolute, chunk.startLine, chunk.endLine, text, scope, createdAt)
      insertFts.run(text, id, scope)
    }
  }

  private _bumpAccess(results: readonly MemorySearchResult[]): void {
    const db = this._db
    /* v8 ignore next -- search guards the database through _requireDb before bumping access */
    if (db === undefined) return
    const bump = db.prepare('UPDATE chunks SET access_count = access_count + 1 WHERE id = ?')
    for (const result of results) bump.run(result.chunk.id)
  }

  private async _collectFiles(directory: string, scope: MemoryScope, files: MemoryFile[]): Promise<void> {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      /* v8 ignore next -- list() calls ensureMemoryDirectories before collecting, so the roots always exist */
      return
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue
      let path
      try {
        path = MemoryPath(scope, entry.name)
      } catch {
        continue
      }
      const absolute = join(directory, entry.name)
      let info
      try {
        info = await stat(absolute)
      } catch {
        /* v8 ignore next -- a listed file can only fail to stat through an I/O race */
        continue
      }
      files.push({
        path,
        scope,
        sizeBytes: info.size,
        modifiedAt: info.mtimeMs,
      })
    }
  }

  private async _collectSessionFiles(files: MemoryFile[]): Promise<void> {
    for (const { name, absolute } of await this._listSessionArchives()) {
      let info
      try {
        info = await stat(absolute)
      } catch {
        /* v8 ignore next -- a listed file can only fail to stat through an I/O race */
        continue
      }
      files.push({
        path: MemoryPath('session', 'sessions', name),
        scope: 'session',
        sizeBytes: info.size,
        modifiedAt: info.mtimeMs,
      })
    }
  }

  private _chunksOf(state: FileState): readonly MemoryChunk[] {
    const chunks = chunkMarkdown(state.content, this._chunkConfig)
    const scope = pathScope(state.path)
    const createdAt = Date.now()
    return chunks.map(chunk => ({
      id: chunkHashOf(chunk.text) as MemoryChunkId,
      path: state.path,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      text: chunk.text,
      source: scope,
      accessCount: 0,
      createdAt,
    }))
  }
}

function chunkHashOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 24)
}

function rowOf(chunk: MemoryChunk): MemoryChunkRowLike {
  return {
    id: chunk.id,
    path: chunk.path,
    start_line: chunk.startLine,
    end_line: chunk.endLine,
    text: chunk.text,
    source: chunk.source,
    access_count: chunk.accessCount,
    created_at: chunk.createdAt,
  }
}

/** Minimal row-like adapter for scoring domain chunks. */
interface MemoryChunkRowLike {
  readonly id: string
  readonly path: string
  readonly start_line: number
  readonly end_line: number
  readonly text: string
  readonly source: MemoryScope
  readonly access_count: number
  readonly created_at: number
}

function resolveConfig(config: Config): ResolvedConfig {
  if (typeof config.workspace !== 'string' || config.workspace.trim().length === 0) {
    throw new MemoryError('memory-markdown: workspace must not be blank', 'MEMORY_INVALID_CONFIG')
  }
  const maxChunkChars = config.index?.maxChunkChars ?? MEMORY_DEFAULT_MAX_CHUNK_CHARS
  const chunkOverlapChars = config.index?.chunkOverlapChars ?? MEMORY_DEFAULT_CHUNK_OVERLAP_CHARS
  if (!Number.isSafeInteger(maxChunkChars) || maxChunkChars < 1) {
    throw new MemoryError('memory-markdown: maxChunkChars must be a positive safe integer', 'MEMORY_INVALID_CONFIG')
  }
  if (!Number.isSafeInteger(chunkOverlapChars) || chunkOverlapChars < 0) {
    throw new MemoryError(
      'memory-markdown: chunkOverlapChars must be a non-negative safe integer',
      'MEMORY_INVALID_CONFIG',
    )
  }
  const openAt = config.openAt ?? 'startup'
  const openPhases: readonly string[] = ['startup', 'first-search', 'never']
  if (!openPhases.includes(openAt)) throw new MemoryError('memory-markdown: openAt is not supported', 'MEMORY_INVALID_CONFIG')
  const journalMode = config.journalMode ?? MEMORY_MARKDOWN_DEFAULT_JOURNAL
  const journalModes: readonly string[] = ['wal', 'delete', 'truncate', 'persist']
  if (!journalModes.includes(journalMode)) {
    throw new MemoryError('memory-markdown: journalMode is not supported', 'MEMORY_INVALID_CONFIG')
  }
  const root = config.root
  const dshHome = config.dshHome
  const layout = resolveMemoryLayout(config.workspace, root, dshHome)
  const path = config.path ?? join(layout.root, 'index.sqlite')
  return {
    maxChunkChars,
    chunkOverlapChars,
    openAt,
    journalMode,
    root: layout.root,
    workspace: config.workspace,
    dshHome,
    path,
  }
}

function errorMessage(error: unknown): string {
  /* v8 ignore next -- open and stat failures are always Error instances, so only the Error arm is reachable */
  return error instanceof Error ? error.message : 'unknown error'
}

export default MarkdownMemoryService
