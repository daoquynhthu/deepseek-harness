/**
 * Markdown-backed cross-session memory provider.
 *
 * Stores curated knowledge as editable markdown under the harness home,
 * indexes chunks with SQLite FTS5, and serves keyword search through the
 * `ctx.memory` service. The shipped path is FTS-only with zero LLM or
 * embedding calls; vector retrieval is a deferred follow-up. An optional
 * file-system watcher refreshes the index when memory files change outside
 * the provider.
 *
 * @module @deepseek-ai/dsh-memory-markdown
 */

import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { BlockAssembler, createUserMessage, type ContentBlock, type GenerateOptions } from '@deepseek-ai/dsh-llm'
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
import { keywordScan, makeSnippet, rowToChunk, scoreRow, extractKeywords, segmentForIndex, type IndexedChunkRow } from './query.ts'
import { openMemoryDatabase, readMeta, writeMeta, type JournalMode } from './schema.ts'
import { MemoryWatcher } from './watcher.ts'
import {
  MEMORY_DREAM_META_CONSUMED,
  MEMORY_DREAM_META_LAST_RUN,
  computeDreamSelection,
  dreamFinishError,
  dreamPrompt,
  renderDreamSection,
} from './dream.ts'
import {
  MEMORY_ARCHIVE_MAX_TOPICS,
  MEMORY_ARCHIVE_SLUG_MAX_CHARS,
  archiveDateParts,
  archiveIsExpired,
  archiveMessageCounts,
  meetsSessionArchiveGate,
  realUserQueryTexts,
  renderArchiveCard,
  sessionArchiveName,
  sessionArchiveSid8,
  slugify,
} from './archive.ts'

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
export { extractKeywords, keywordScan, segmentForIndex } from './query.ts'

/** Default journal mode for the memory index. */
export const MEMORY_MARKDOWN_DEFAULT_JOURNAL = 'wal'

/** Default for archiving a substantial session to the sessions directory when it ends. */
export const MEMORY_MARKDOWN_DEFAULT_SAVE_ON_END = true

/** Default debounce window for watcher change events. */
export const MEMORY_WATCHER_DEFAULT_DEBOUNCE_MS = 100

/** Default polling interval when native watching is unavailable. */
export const MEMORY_WATCHER_DEFAULT_POLL_INTERVAL_MS = 5000

/** Default for the background dream-consolidation pass. */
export const MEMORY_MARKDOWN_DEFAULT_DREAM_ENABLED = false

/** Default minimum hours between dream passes. */
export const MEMORY_MARKDOWN_DEFAULT_DREAM_INTERVAL_HOURS = 24

/** Default minimum un-consolidated session archives before a pass runs. */
export const MEMORY_MARKDOWN_DEFAULT_DREAM_MIN_NEW_ARCHIVES = 3

/** Default maximum session archives consolidated per pass. */
export const MEMORY_MARKDOWN_DEFAULT_DREAM_MAX_ARCHIVES_PER_PASS = 10

/** Default maximum output tokens for a consolidation call. */
export const MEMORY_MARKDOWN_DEFAULT_DREAM_MAX_TOKENS = 1024

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
  /** Session-end archival configuration. */
  session?: {
    /** Archive a substantial session to the sessions directory when it ends. Defaults to true. */
    saveOnEnd?: boolean
    /** Prune session archives whose session date is older than this many days. Off when omitted. */
    retentionDays?: number
  }
  /** File-system watcher for external edits to memory files. Off by default. */
  watcher?: {
    /** Watch memory directories and refresh the index on external edits. Defaults to false. */
    enabled?: boolean
    /** Milliseconds to coalesce rapid file-system events. Defaults to 100. */
    debounceMs?: number
    /** Milliseconds between polling probes when native watching is unavailable. Defaults to 5000. */
    pollIntervalMs?: number
  }
  /** Background LLM consolidation of session archives into workspace memory. Off by default. */
  dream?: {
    /** Run the gated consolidation pass after session archives are written. Defaults to false. */
    enabled?: boolean
    /** Minimum hours between dream passes. Defaults to 24. */
    intervalHours?: number
    /** Minimum un-consolidated session archives before a pass runs. Defaults to 3. */
    minNewArchives?: number
    /** Maximum session archives consolidated per pass. Defaults to 10. */
    maxArchivesPerPass?: number
    /** Maximum output tokens for a consolidation call. Defaults to 1024. */
    maxTokens?: number
    /** Consolidation provider; supply with `model`, otherwise the triggering session's routed provider. */
    provider?: string
    /** Consolidation model; supply with `provider`, otherwise the triggering session's routed model. */
    model?: string
  }
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
  saveOnEnd: boolean
  retentionDays: number | undefined
  watcherEnabled: boolean
  watcherDebounceMs: number
  watcherPollIntervalMs: number
  dreamEnabled: boolean
  dreamIntervalHours: number
  dreamMinNewArchives: number
  dreamMaxArchivesPerPass: number
  dreamMaxTokens: number
  dreamProvider: string | undefined
  dreamModel: string | undefined
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
    temporalDecayEnabled: z.boolean(),
    halfLifeDays: z.number().min(0.000001),
    sourceWeights: z.object({}),
    candidateMultiplier: z.number().step(1).min(1),
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
    session: z.object({
      saveOnEnd: z.boolean(),
      retentionDays: z.number().step(1).min(1),
    }),
    watcher: z.object({
      enabled: z.boolean(),
      debounceMs: z.number().step(1).min(1),
      pollIntervalMs: z.number().step(1).min(1),
    }),
    dream: z.object({
      enabled: z.boolean(),
      intervalHours: z.number().step(1).min(1),
      minNewArchives: z.number().step(1).min(1),
      maxArchivesPerPass: z.number().step(1).min(1),
      maxTokens: z.number().step(1).min(1),
      provider: z.string(),
      model: z.string(),
    }),
  })

  private readonly _resolved: ResolvedConfig
  private readonly _layout: MemoryLayout
  private readonly _chunkConfig: ChunkConfig
  private _db: DatabaseSync | undefined
  private _ready: Promise<void> | undefined
  private _closed = false
  private _watcher: MemoryWatcher | undefined
  private _dreamRunning: Promise<void> | undefined
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
    ctx.on('session/flush', session => this._archiveOnFlush(session))
  }

  /** Open eagerly only when activation owns the configured readiness boundary. */
  protected async [Service.init](): Promise<void> {
    if (this._resolved.openAt === 'startup') await this._ensureReady()
    this._startWatcher()
  }

  /** Start the file-system watcher unless indexing is disabled. */
  private _startWatcher(): void {
    if (!this._resolved.watcherEnabled || this._resolved.openAt === 'never') return
    const watcher = new MemoryWatcher({
      dirs: [this._layout.globalDir, this._layout.workspaceDir, this._layout.sessionsDir],
      debounceMs: this._resolved.watcherDebounceMs,
      pollIntervalMs: this._resolved.watcherPollIntervalMs,
      onChange: () => {
        /* v8 ignore start -- a refresh only rejects when a memory root becomes unwritable, which needs a read-only mount to reproduce */
        void this._refreshRoots().catch((error: unknown) => {
          this.ctx.logger.warn(`memory: watcher refresh failed: ${errorMessage(error)}`)
        })
        /* v8 ignore stop */
      },
    })
    watcher.start()
    this._watcher = watcher
    this.ctx.effect(() => () => this._watcher?.dispose(), 'memoryMarkdown.watcher')
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
    const window = limits.limit * this.config.search.candidateMultiplier
    const scanned = keywordScan(db, keywords, request.scope, window)
    const now = Date.now()
    const rows = scanned.rows
    const contentRows: IndexedChunkRow[] = []
    for (const row of rows) {
      const chunk = rowToChunk(row)
      if (isContentFree(chunk.text, chunk.source)) continue
      contentRows.push(row)
    }
    const candidates: Array<{ chunk: MemoryChunk; base: number }> = []
    for (const [index, row] of contentRows.entries()) {
      candidates.push({ chunk: rowToChunk(row), base: 1 - index / Math.max(1, contentRows.length) })
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
      total: contentRows.length,
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
    `).all() as unknown as IndexedChunkRow[]
    return rows
      .map(rowToChunk)
      .filter(chunk => !isContentFree(chunk.text, chunk.source))
      .slice(0, request.maxChunks)
  }

  /** Archive a substantial session to the sessions directory at each durable flush. */
  private async _archiveOnFlush(session: Session): Promise<void> {
    if (!this._resolved.saveOnEnd) return
    if (session.header.origin === 'subagent') return
    const events = session.events
    const queries = realUserQueryTexts(events)
    if (!meetsSessionArchiveGate(queries)) return
    const counts = archiveMessageCounts(events)
    const sid8 = sessionArchiveSid8(session.id)
    /* v8 ignore next -- the gate guarantees at least three queries, and an empty first query falls back to the slug default */
    const slug = slugify(queries[0] ?? '', MEMORY_ARCHIVE_SLUG_MAX_CHARS) || 'session'
    const { date, stamp } = archiveDateParts(session.header.createdAt)
    const card = renderArchiveCard(stamp, counts, queries.slice(0, MEMORY_ARCHIVE_MAX_TOPICS))
    let path: MemoryPathValue
    try {
      path = MemoryPath('session', 'sessions', sessionArchiveName(date, slug, sid8))
    } catch (error) {
      /* v8 ignore start -- a slug, date, and hex suffix always match the archive name contract */
      this.ctx.logger.warn(`memory: session "${session.id}" archive name rejected: ${String(error)}`)
      return
      /* v8 ignore stop */
    }
    try {
      const absolute = absolutePath(this._layout, path)
      await writeMemoryFile(absolute, card)
      this._files.set(absolute, { path, absolute, content: card })
      this._reindex(absolute)
      void this._maybeDream(session)
    } catch (error) {
      /* v8 ignore start -- an unwritable sessions directory cannot be exercised without a read-only mount */
      this.ctx.logger.warn(`memory: session "${session.id}" archive write failed: ${String(error)}`)
      /* v8 ignore stop */
    }
  }

  /** Run one dream pass when the gates clear; concurrent triggers coalesce. */
  private _maybeDream(session: Session): Promise<void> {
    if (!this._resolved.dreamEnabled) return Promise.resolve()
    if (this._dreamRunning !== undefined) return this._dreamRunning
    const running = this._runDreamPass(session).finally(() => {
      this._dreamRunning = undefined
    })
    this._dreamRunning = running
    return running
  }

  /** Best-effort consolidation pass; every failure is logged, never thrown. */
  private async _runDreamPass(session: Session): Promise<void> {
    try {
      const db = this._db
      if (db === undefined) return
      const llm = this.ctx.get('llm')
      if (llm === undefined) {
        this.ctx.logger.warn('memory: dream consolidation skipped because the llm service is not loaded')
        return
      }
      const route = this._resolved.dreamProvider === undefined
        ? session.requestHeader()?.config
        : { provider: this._resolved.dreamProvider, model: this._resolved.dreamModel as string }
      if (route === undefined || route.provider.length === 0 || route.model.length === 0) {
        this.ctx.logger.warn('memory: dream consolidation skipped because no provider/model route is available')
        return
      }
      const archives = await this._listSessionArchives()
      const consumed = new Set<string>()
      for (const name of JSON.parse(readMeta(db, MEMORY_DREAM_META_CONSUMED) ?? '[]') as unknown[]) {
        if (typeof name === 'string') consumed.add(name)
      }
      const names = new Set(archives.map(archive => archive.name))
      for (const name of [...consumed]) {
        if (!names.has(name)) consumed.delete(name)
      }
      const lastRun = readMeta(db, MEMORY_DREAM_META_LAST_RUN)
      const lastRunMs = lastRun === undefined ? undefined : Date.parse(lastRun)
      const { selected, skip } = computeDreamSelection(
        [...names],
        consumed,
        this._resolved.dreamMinNewArchives,
        this._resolved.dreamMaxArchivesPerPass,
        this._resolved.dreamIntervalHours,
        Date.now(),
        lastRunMs,
      )
      if (skip) return
      const cards: string[] = []
      for (const archive of archives) {
        if (!selected.includes(archive.name)) continue
        try {
          cards.push(await readMemoryFile(archive.absolute))
        } catch {
          /* v8 ignore next -- a listed archive can only fail to load through an I/O race */
          continue
        }
      }
      let existing: string | undefined
      try {
        existing = await readMemoryFile(this._layout.workspaceMemoryFile)
      } catch (error: unknown) {
        if ((error as { code?: string }).code !== 'MEMORY_FILE_NOT_FOUND') throw error
        existing = undefined
      }
      const { system, user } = dreamPrompt(existing, cards)
      const options: GenerateOptions = {
        provider: route.provider,
        model: route.model,
        messages: [createUserMessage({
          content: [{ type: 'text', text: user }],
          source: { kind: 'plugin', plugin: 'dsh-memory-markdown' },
        })],
        system,
        maxTokens: this._resolved.dreamMaxTokens,
        purpose: 'dream',
        sessionId: session.id,
      }
      const assembler = new BlockAssembler()
      for await (const chunk of llm.stream(options)) assembler.push(chunk)
      const finishError = dreamFinishError(assembler.finish)
      if (finishError !== undefined) throw finishError
      const text = assembler.blocks()
        .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
        .map(block => block.text)
        .join('\n')
        .trim()
      if (text.length > 0) {
        const { date } = archiveDateParts(Date.now())
        const section = renderDreamSection(date, text)
        const next = existing === undefined
          ? `# Workspace memory\n\n${section}`
          : `${existing.trimEnd()}\n\n${section}`
        const absolute = this._layout.workspaceMemoryFile
        await writeMemoryFile(absolute, next)
        this._files.set(absolute, { path: MemoryPath('workspace', 'MEMORY.md'), absolute, content: next })
        this._reindex(absolute)
      }
      for (const name of selected) consumed.add(name)
      writeMeta(db, MEMORY_DREAM_META_CONSUMED, JSON.stringify([...consumed].sort()))
      writeMeta(db, MEMORY_DREAM_META_LAST_RUN, new Date().toISOString())
      session.append('memory/dream', {
        route: { provider: route.provider, model: route.model },
        archives: [...selected],
        system,
        user,
        output: text,
      })
    } catch (error: unknown) {
      this.ctx.logger.warn(`memory: dream consolidation failed: ${errorMessage(error)}`)
    }
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
    await this._refreshRoots()
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

  /** Rescan memory roots, reindexing changed files and purging deleted ones. */
  private async _refreshRoots(): Promise<void> {
    if (this._db === undefined) return
    await ensureMemoryDirectories(this._layout)
    const known = new Set<string>()
    const retained = new Set<string>()
    await this._scanRootFresh(this._layout.globalDir, 'global', known, retained)
    await this._scanRootFresh(this._layout.workspaceDir, 'workspace', known, retained)
    await this._scanRootFresh(this._layout.sessionsDir, 'session', known, retained)
    const retentionDays = this._resolved.retentionDays
    if (retentionDays !== undefined) {
      const now = new Date()
      const cutoffMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - retentionDays * 86_400_000
      await this._pruneExpiredArchives(known, retained, cutoffMs)
    }
    this._purgeMissing(known)
    for (const absolute of this._files.keys()) {
      if (!retained.has(absolute)) this._files.delete(absolute)
    }
  }

  /** Delete session archives whose session date is older than the cutoff day. */
  private async _pruneExpiredArchives(known: Set<string>, retained: Set<string>, cutoffMs: number): Promise<void> {
    for (const { path, absolute, name } of await this._listSessionArchives()) {
      if (!archiveIsExpired(name, cutoffMs)) continue
      try {
        await rm(absolute, { force: true })
      } catch {
        /* v8 ignore next -- a listed archive can only fail to delete through an I/O race */
        continue
      }
      known.delete(path)
      retained.delete(absolute)
      this._files.delete(absolute)
    }
  }

  private async _scanRootFresh(
    directory: string,
    scope: MemoryScope,
    known: Set<string>,
    retained: Set<string>,
  ): Promise<void> {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      /* v8 ignore next -- a refresh-scanned root is ensured to exist before listing */
      return
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue
      let path: MemoryPathValue
      try {
        path = scope === 'session'
          ? MemoryPath('session', 'sessions', entry.name)
          : MemoryPath(scope, entry.name)
      } catch {
        continue
      }
      const absolute = join(directory, entry.name)
      known.add(path)
      retained.add(absolute)
      let content: string
      try {
        content = await readMemoryFile(absolute)
      } catch {
        /* v8 ignore next -- a listed file can only fail to load through an I/O race */
        continue
      }
      const cached = this._files.get(absolute)
      if (cached !== undefined && cached.content === content) {
        const db = this._db
        /* v8 ignore next -- _refreshRoots guards the database before scanning */
        if (db !== undefined && db.prepare('SELECT 1 FROM chunks WHERE path = ? LIMIT 1').get(path) !== undefined) {
          continue
        }
      }
      this._files.set(absolute, { path, absolute, content })
      this._reindex(absolute)
    }
  }

  /** List the `.md` session-archive files under the sessions directory. */
  private async _listSessionArchives(): Promise<Array<{ path: MemoryPathValue; absolute: string; name: string }>> {
    let entries
    try {
      entries = await readdir(this._layout.sessionsDir, { withFileTypes: true })
    } catch {
      /* v8 ignore next -- callers create sessionsDir before listing, so readdir cannot fail here */
      return []
    }
    const archives: Array<{ path: MemoryPathValue; absolute: string; name: string }> = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue
      let path: MemoryPathValue
      try {
        path = MemoryPath('session', 'sessions', entry.name)
      } catch {
        continue
      }
      archives.push({ path, absolute: join(this._layout.sessionsDir, entry.name), name: entry.name })
    }
    return archives
  }

  /** Drop index rows for files that no longer exist on disk. */
  private _purgeMissing(known: ReadonlySet<string>): void {
    const db = this._db
    /* v8 ignore next -- purge runs only from _refreshRoots after _open has opened the database */
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
    const existing = new Map<string, { createdAt: number; accessCount: number }>()
    for (const row of db.prepare(
      'SELECT id, created_at, access_count FROM chunks WHERE path = ?',
    ).all(state.path) as Array<{ id: string; created_at: number; access_count: number }>) {
      existing.set(row.id, { createdAt: row.created_at, accessCount: row.access_count })
    }
    db.prepare('DELETE FROM chunks_fts WHERE id IN (SELECT id FROM chunks WHERE path = ?)').run(state.path)
    db.prepare('DELETE FROM chunks WHERE path = ?').run(state.path)
    const now = Date.now()
    const chunks = chunkMarkdown(state.content, this._chunkConfig)
    const insert = db.prepare(`
      INSERT INTO chunks (id, path, start_line, end_line, text, source, access_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const insertFts = db.prepare(`
      INSERT INTO chunks_fts (text, id, source)
      VALUES (?, ?, ?)
    `)
    for (const chunk of chunks) {
      const id = chunkHashOf(chunk.text)
      const text = chunk.text
      const prior = existing.get(id)
      insert.run(id, state.path, chunk.startLine, chunk.endLine, text, scope, prior?.accessCount ?? 0, prior?.createdAt ?? now)
      insertFts.run(segmentForIndex(text), id, scope)
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
    for (const { path, absolute } of await this._listSessionArchives()) {
      let info
      try {
        info = await stat(absolute)
      } catch {
        /* v8 ignore next -- a listed file can only fail to stat through an I/O race */
        continue
      }
      files.push({
        path,
        scope: 'session',
        sizeBytes: info.size,
        modifiedAt: info.mtimeMs,
      })
    }
  }

  private _chunksOf(state: FileState): readonly MemoryChunk[] {
    const chunks = chunkMarkdown(state.content, this._chunkConfig)
    const scope = pathScope(state.path)
    const durable = new Map<string, { accessCount: number; createdAt: number }>()
    if (this._db !== undefined) {
      for (const row of this._db.prepare(
        'SELECT id, access_count, created_at FROM chunks WHERE path = ?',
      ).all(state.path) as Array<{ id: string; access_count: number; created_at: number }>) {
        durable.set(row.id, { accessCount: row.access_count, createdAt: row.created_at })
      }
    }
    return chunks.map((chunk) => {
      const id = chunkHashOf(chunk.text) as MemoryChunkId
      const prior = durable.get(id)
      return {
        id,
        path: state.path,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        text: chunk.text,
        source: scope,
        accessCount: prior?.accessCount ?? 0,
        createdAt: prior?.createdAt ?? Date.now(),
      }
    })
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
  const saveOnEnd = config.session?.saveOnEnd ?? MEMORY_MARKDOWN_DEFAULT_SAVE_ON_END
  const retentionDays = config.session?.retentionDays
  if (retentionDays !== undefined && (!Number.isSafeInteger(retentionDays) || retentionDays < 1)) {
    throw new MemoryError(
      'memory-markdown: session.retentionDays must be a positive safe integer when set',
      'MEMORY_INVALID_CONFIG',
    )
  }
  const watcherEnabled = config.watcher?.enabled ?? false
  const watcherDebounceMs = config.watcher?.debounceMs ?? MEMORY_WATCHER_DEFAULT_DEBOUNCE_MS
  const watcherPollIntervalMs = config.watcher?.pollIntervalMs ?? MEMORY_WATCHER_DEFAULT_POLL_INTERVAL_MS
  for (const [name, value] of [
    ['watcher.debounceMs', watcherDebounceMs],
    ['watcher.pollIntervalMs', watcherPollIntervalMs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new MemoryError(`memory-markdown: ${name} must be a positive safe integer`, 'MEMORY_INVALID_CONFIG')
    }
  }
  const dreamEnabled = config.dream?.enabled ?? MEMORY_MARKDOWN_DEFAULT_DREAM_ENABLED
  const dreamIntervalHours = config.dream?.intervalHours ?? MEMORY_MARKDOWN_DEFAULT_DREAM_INTERVAL_HOURS
  const dreamMinNewArchives = config.dream?.minNewArchives ?? MEMORY_MARKDOWN_DEFAULT_DREAM_MIN_NEW_ARCHIVES
  const dreamMaxArchivesPerPass = config.dream?.maxArchivesPerPass ?? MEMORY_MARKDOWN_DEFAULT_DREAM_MAX_ARCHIVES_PER_PASS
  const dreamMaxTokens = config.dream?.maxTokens ?? MEMORY_MARKDOWN_DEFAULT_DREAM_MAX_TOKENS
  const dreamProvider = config.dream?.provider
  const dreamModel = config.dream?.model
  if ((dreamProvider === undefined) !== (dreamModel === undefined)) {
    throw new MemoryError(
      'memory-markdown: dream.provider and dream.model must be supplied together',
      'MEMORY_INVALID_CONFIG',
    )
  }
  for (const [name, value] of [
    ['dream.intervalHours', dreamIntervalHours],
    ['dream.minNewArchives', dreamMinNewArchives],
    ['dream.maxArchivesPerPass', dreamMaxArchivesPerPass],
    ['dream.maxTokens', dreamMaxTokens],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new MemoryError(`memory-markdown: ${name} must be a positive safe integer`, 'MEMORY_INVALID_CONFIG')
    }
  }
  if (dreamProvider !== undefined && (dreamProvider.trim().length === 0 || dreamModel === undefined || dreamModel.trim().length === 0)) {
    throw new MemoryError(
      'memory-markdown: dream.provider and dream.model must be non-empty strings',
      'MEMORY_INVALID_CONFIG',
    )
  }
  return {
    maxChunkChars,
    chunkOverlapChars,
    openAt,
    journalMode,
    root: layout.root,
    workspace: config.workspace,
    dshHome,
    path,
    saveOnEnd,
    retentionDays,
    watcherEnabled,
    watcherDebounceMs,
    watcherPollIntervalMs,
    dreamEnabled,
    dreamIntervalHours,
    dreamMinNewArchives,
    dreamMaxArchivesPerPass,
    dreamMaxTokens,
    dreamProvider,
    dreamModel,
  }
}

function errorMessage(error: unknown): string {
  /* v8 ignore next -- open and stat failures are always Error instances, so only the Error arm is reachable */
  return error instanceof Error ? error.message : 'unknown error'
}

export default MarkdownMemoryService
