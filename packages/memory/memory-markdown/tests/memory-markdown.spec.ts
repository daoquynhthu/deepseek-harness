import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, LlmRuntime, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { MemoryPath, type MemoryChunk, type MemoryChunkId } from '@deepseek-ai/dsh-memory'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { MEMORY_DREAM_META_CONSUMED } from '../src/dream.ts'
import '../src/types.ts'
import MarkdownMemoryService, {
  MEMORY_SQLITE_SCHEMA_VERSION,
  MEMORY_SQLITE_APPLICATION_ID,
} from '../src/index.ts'
import {
  absolutePath,
  ensureMemoryDirectories,
  pathScope,
  readMemoryFile,
  resolveMemoryLayout,
  workspaceHashOf,
  writeMemoryFile,
} from '../src/layout.ts'
import { extractKeywords, filterContentFree, keywordScan, makeSnippet, scoreRow, rowToChunk, segmentForIndex } from '../src/query.ts'
import { openMemoryDatabase, readMeta, writeMeta } from '../src/schema.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

async function temporaryPath(name = 'memory'): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-memory-'))
  temporaryDirectories.push(directory)
  return join(directory, name)
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('condition not satisfied in time')
}

/** Scripted LLM adapter recording every dream request. */
class DreamAdapter extends LlmAdapter {
  requests: GenerateOptions[] = []

  constructor(
    private readonly text: string,
    private readonly finish: (StreamChunk & { type: 'finish' })['reason'] = { kind: 'stop' },
  ) {
    super()
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.text.length > 0) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: this.text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: this.text } }
    }
    yield { type: 'finish', reason: this.finish }
  }
}

/** Invoke the private dream pass on the mounted provider. */
async function runDream(service: unknown, session: Session): Promise<void> {
  await (service as { _maybeDream(session: Session): Promise<void> })._maybeDream(session)
}

describe('layout', () => {
  it('resolves roots, workspace hash, and scoped file paths', () => {
    const root = join(tmpdir(), 'memory-root')
    const workspace = join(tmpdir(), 'work-alpha')
    const layout = resolveMemoryLayout(workspace, root, undefined)
    const hash = workspaceHashOf(workspace)
    expect(layout.root).toBe(root)
    expect(layout.globalDir).toBe(root)
    expect(layout.globalMemoryFile).toBe(join(root, 'MEMORY.md'))
    expect(layout.workspaceDir).toBe(join(root, hash))
    expect(layout.workspaceMemoryFile).toBe(join(root, hash, 'MEMORY.md'))
    expect(layout.sessionsDir).toBe(join(root, hash, 'sessions'))
    expect(hash).toMatch(/^[0-9a-f]{16}$/)
  })

  it('maps branded paths to absolute scoped paths and scopes', async () => {
    const layout = resolveMemoryLayout('/work/alpha', await temporaryPath(), undefined)
    const global = MemoryPath('global', 'MEMORY.md')
    const workspace = MemoryPath('workspace', 'MEMORY.md')
    const session = MemoryPath('session', 'sessions', '2026-08-16-demo-a1b2c3d4.md')
    expect(absolutePath(layout, global)).toBe(layout.globalMemoryFile)
    expect(absolutePath(layout, workspace)).toBe(layout.workspaceMemoryFile)
    expect(absolutePath(layout, session)).toBe(join(layout.sessionsDir, '2026-08-16-demo-a1b2c3d4.md'))
    expect(pathScope(global)).toBe('global')
    expect(pathScope(workspace)).toBe('workspace')
    expect(pathScope(session)).toBe('session')
  })

  it('resolves the default root under the harness home when no override is given', () => {
    const layout = resolveMemoryLayout('/work/alpha', undefined, 'C:/custom-home')
    expect(layout.root).toBe(join(resolve('C:/custom-home'), 'memory'))
    expect(layout.globalMemoryFile).toBe(join(resolve('C:/custom-home'), 'memory', 'MEMORY.md'))
  })

  it('creates directories and atomically writes then reads files', async () => {
    const layout = resolveMemoryLayout('/work/alpha', await temporaryPath(), undefined)
    await ensureMemoryDirectories(layout)
    await writeMemoryFile(layout.globalMemoryFile, 'hello')
    await expect(readMemoryFile(layout.globalMemoryFile)).resolves.toBe('hello')
    await expect(readMemoryFile(join(layout.globalDir, 'missing.md'))).rejects.toMatchObject({
      code: 'MEMORY_FILE_NOT_FOUND',
    })
    await expect(readMemoryFile(layout.globalDir)).rejects.toMatchObject({ code: 'EISDIR' })
  })
})

describe('schema', () => {
  it('opens an empty index, creating the derived schema', async () => {
    const db = await openMemoryDatabase(await temporaryPath('index.sqlite'), 'wal')
    try {
      const applicationId = db.prepare('PRAGMA application_id').get() as { application_id: number }
      const version = db.prepare('PRAGMA user_version').get() as { user_version: number }
      expect(applicationId.application_id).toBe(MEMORY_SQLITE_APPLICATION_ID)
      expect(version.user_version).toBe(MEMORY_SQLITE_SCHEMA_VERSION)
    } finally {
      db.close()
    }
  })

  it('opens in-memory databases and rejects a foreign application id', async () => {
    const memory = await openMemoryDatabase(':memory:', 'delete')
    memory.close()

    const foreign = await temporaryPath('foreign.sqlite')
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(foreign)
    db.exec('PRAGMA application_id = 12345')
    db.close()
    await expect(openMemoryDatabase(foreign, 'wal')).rejects.toThrow(/belongs to another application/)
  })

  it('rejects an index with unrecognized user tables', async () => {
    const path = await temporaryPath('dirty.sqlite')
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(path)
    db.exec('PRAGMA application_id = 0x4d454d31')
    db.exec('CREATE TABLE unrelated (id INTEGER)')
    db.close()
    await expect(openMemoryDatabase(path, 'wal')).rejects.toThrow(/unrecognized user tables/)
  })

  it('resets an outdated recognized schema in place', async () => {
    const path = await temporaryPath('old.sqlite')
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(path)
    db.exec('PRAGMA application_id = 0x4d454d31')
    db.exec('PRAGMA user_version = 0')
    db.exec('CREATE TABLE chunks (id TEXT PRIMARY KEY)')
    db.close()
    const reopened = await openMemoryDatabase(path, 'wal')
    try {
      const version = reopened.prepare('PRAGMA user_version').get() as { user_version: number }
      expect(version.user_version).toBe(MEMORY_SQLITE_SCHEMA_VERSION)
    } finally {
      reopened.close()
    }
  })

  it('rejects a foreign file that has no recognized application id', async () => {
    const path = await temporaryPath('unclaimed.sqlite')
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(path)
    db.exec('CREATE TABLE unrelated (id INTEGER)')
    db.close()
    await expect(openMemoryDatabase(path, 'wal')).rejects.toThrow(/not an empty or recognized derived index/)
  })

  it('propagates file-creation errors other than EEXIST', async () => {
    const base = await mkdtemp(join(tmpdir(), 'dsh-memory-'))
    temporaryDirectories.push(base)
    await expect(openMemoryDatabase(join(base, 'bad\u0000name.sqlite'), 'wal')).rejects.toThrow(
      /null bytes/i,
    )
  })
})

describe('query helpers', () => {
  it('extracts unique keywords while dropping stop words', () => {
    expect(extractKeywords('The quick brown fox and the quick DOG')).toEqual([
      'quick', 'brown', 'fox', 'dog',
    ])
    expect(extractKeywords('the and or')).toEqual([])
    expect(extractKeywords('what was the solution for the authentication bug')).toEqual([
      'solution', 'authentication', 'bug',
    ])
    expect(extractKeywords('how do I configure the memory system')).toEqual([
      'configure', 'memory', 'system',
    ])
    expect(extractKeywords('show me that database migration we talked about')).toEqual([
      'database', 'migration', 'talked',
    ])
    expect(extractKeywords('that thing we discussed about the API')).toEqual([
      'discussed', 'api',
    ])
  })

  it('drops single-character and pure-numeric tokens while preserving meaningful short terms', () => {
    expect(extractKeywords('I a x language')).toEqual(['language'])
    expect(extractKeywords('Go and JS patterns')).toEqual(['go', 'js', 'patterns'])
    expect(extractKeywords('port 8080 and 443 config')).toEqual(['port', 'config'])
  })

  it('keeps underscore inside tokens so identifiers survive', () => {
    expect(extractKeywords('the my_function variable')).toEqual(['my_function', 'variable'])
  })

  it('segments Han runs for FTS while leaving ASCII text untouched', () => {
    expect(segmentForIndex('部署约定：永远在 CI 运行')).toBe('部署 约定：永远 在 CI 运行')
    expect(segmentForIndex('the quick brown fox')).toBe('the quick brown fox')
    expect(segmentForIndex('my_function 项目记忆')).toBe('my_function 项目 记忆')
  })

  it('extracts Chinese keywords after segmentation, dropping Chinese stop words', () => {
    expect(extractKeywords('发布约定')).toEqual(['发布', '约定'])
    expect(extractKeywords('项目的部署约定是什么')).toEqual(['项目', '部署', '约定'])
    expect(extractKeywords('请帮我在 CI 运行发布清单')).toEqual(['我在', 'ci', '运行', '发布', '清单'])
    expect(extractKeywords('的 了 是')).toEqual([])
  })

  it('matches Chinese terms in the FTS index through the same segmentation', async () => {
    const db = await openMemoryDatabase(':memory:', 'wal')
    try {
      db.exec(`INSERT INTO chunks (id, path, start_line, end_line, text, source, access_count, created_at)
        VALUES ('a', 'MEMORY.md', 0, 1, '发布约定：永远在 CI 运行发布清单，绝不本地发布。', 'global', 0, 1)`)
      db.exec(`INSERT INTO chunks_fts (text, id, source)
        VALUES ('${segmentForIndex('发布约定：永远在 CI 运行发布清单，绝不本地发布。')}', 'a', 'global')`)
      const scan = keywordScan(db, ['发布', '约定'], undefined, 10)
      expect(scan.total).toBe(1)
      expect(scan.rows[0]!.id).toBe('a')
      expect(scan.rows[0]!.text).toContain('发布约定')
      expect(keywordScan(db, ['部署'], undefined, 10).total).toBe(0)
    } finally {
      db.close()
    }
  })

  it('scans the FTS index, capping results and restricting scope', async () => {
    const db = await openMemoryDatabase(':memory:', 'wal')
    try {
      db.exec(`INSERT INTO chunks (id, path, start_line, end_line, text, source, access_count, created_at)
        VALUES ('a', 'MEMORY.md', 0, 1, 'curated deployment convention', 'global', 0, 1)`)
      db.exec(`INSERT INTO chunks_fts (text, id, source)
        VALUES ('curated deployment convention', 'a', 'global')`)
      const scan = keywordScan(db, ['deployment'], undefined, 10)
      expect(scan.total).toBe(1)
      expect(scan.rows[0]!.id).toBe('a')
      expect(keywordScan(db, ['deployment'], 'workspace', 10).rows).toEqual([])
      expect(keywordScan(db, [], undefined, 10).rows).toEqual([])
    } finally {
      db.close()
    }
  })

  it('converts rows to chunks, scores them, and renders snippets', () => {
    const row = {
      id: 'chunk-1',
      path: 'MEMORY.md',
      start_line: 0,
      end_line: 2,
      text: '# Heading\n\nA durable conclusion.',
      source: 'global' as const,
      access_count: 1,
      created_at: 1000,
    }
    const chunk = rowToChunk(row)
    expect(chunk.id).toBe('chunk-1')
    expect(chunk.startLine).toBe(0)
    expect(chunk.source).toBe('global')
    const config = {
      maxResults: 10,
      minScore: 0,
      temporalDecay: { enabled: true, halfLifeDays: 30 },
      sourceWeights: { global: 1, workspace: 1, session: 1 },
      candidateMultiplier: 3,
    }
    const score = scoreRow(row, 0.8, 1000, config, config.sourceWeights)
    expect(score).toBeGreaterThan(0.8)
    expect(makeSnippet(chunk.text)).toBe('A durable conclusion.')
    expect(makeSnippet('# only\n\n# two')).toBe('# only\n\n# two')
  })

  it('reports the true match total before the result cap', async () => {
    const db = await openMemoryDatabase(':memory:', 'wal')
    try {
      for (const id of ['a', 'b', 'c']) {
        db.exec(`INSERT INTO chunks (id, path, start_line, end_line, text, source, access_count, created_at)
          VALUES ('${id}', 'MEMORY.md', 0, 1, 'deployment convention', 'global', 0, 1)`)
        db.exec(`INSERT INTO chunks_fts (text, id, source)
          VALUES ('deployment convention', '${id}', 'global')`)
      }
      const scan = keywordScan(db, ['deployment'], undefined, 2)
      expect(scan.rows).toHaveLength(2)
      expect(scan.total).toBe(3)
    } finally {
      db.close()
    }
  })

  it('filters content-free chunks out of candidate lists', () => {
    const useful: MemoryChunk = {
      id: 'a' as MemoryChunkId,
      path: 'MEMORY.md' as MemoryPath,
      startLine: 0,
      endLine: 1,
      text: 'The deployment convention is pinned.',
      source: 'global',
      accessCount: 0,
      createdAt: 0,
    }
    const empty: MemoryChunk = {
      id: 'b' as MemoryChunkId,
      path: 'MEMORY.md' as MemoryPath,
      startLine: 0,
      endLine: 1,
      text: '# Heading only',
      source: 'global',
      accessCount: 0,
      createdAt: 0,
    }
    const scaffold: MemoryChunk = {
      id: 'c' as MemoryChunkId,
      path: 'MEMORY.md' as MemoryPath,
      startLine: 0,
      endLine: 1,
      text: 'This file is managed automatically.',
      source: 'global',
      accessCount: 0,
      createdAt: 0,
    }
    const kept = filterContentFree([useful, empty, scaffold])
    expect(kept.map(chunk => chunk.id)).toEqual(['a'])
  })
})

describe('MarkdownMemoryService', () => {
  async function mount(root: string): Promise<Context> {
    const ctx = new Context()
    await ctx.plugin(MarkdownMemoryService, {
      root,
      workspace: '/work/alpha',
      openAt: 'startup',
    })
    return ctx
  }

  it('writes, reads, lists, searches, and injects across scopes', async () => {
    const root = await temporaryPath()
    const ctx = await mount(root)
    try {
      const global = MemoryPath('global', 'MEMORY.md')
      const workspace = MemoryPath('workspace', 'MEMORY.md')
      const session = MemoryPath('session', 'sessions', '2026-08-16-demo-a1b2c3d4.md')

      await ctx.memory.write(global, '# Project memory\n\nDeployment convention: pin Node LTS.')
      await ctx.memory.write(workspace, '# Workspace memory\n\nAPI key stays in the vault.')
      await ctx.memory.write(session, '# Session archive\n\nThe live demo passed.')

      await expect(ctx.memory.read(global)).resolves.toContain('Deployment convention')
      await expect(ctx.memory.read(session)).resolves.toContain('live demo')

      const files = await ctx.memory.list()
      expect(files.map(file => file.path).sort()).toEqual(
        ['MEMORY.md', 'sessions/2026-08-16-demo-a1b2c3d4.md', 'workspace/MEMORY.md'].sort(),
      )

      const chunks = await ctx.memory.readChunks(global)
      expect(chunks.length).toBeGreaterThan(0)
      expect(chunks[0]!.source).toBe('global')

      const hits = await ctx.memory.search({ query: 'Deployment convention Node' })
      expect(hits.results.length).toBeGreaterThan(0)
      expect(hits.results[0]!.chunk.text).toContain('Deployment convention')
      expect(hits.results[0]!.mode).toBe('fts-only')
      expect(await ctx.memory.read(hits.results[0]!.chunk.path)).toContain('Deployment convention')

      const injected = await ctx.memory.inject({ maxChunks: 10 })
      const injectedSources = injected.map(chunk => chunk.source)
      expect(injectedSources).toContain('global')
      expect(injectedSources).toContain('workspace')
      expect(injectedSources).not.toContain('session')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('recalls Chinese-curated knowledge through the segmented FTS path', async () => {
    const root = await temporaryPath()
    const ctx = await mount(root)
    try {
      const global = MemoryPath('global', 'MEMORY.md')
      await ctx.memory.write(global, '# 项目记忆\n\n发布约定：永远在 CI 运行发布清单，绝不本地发布。\n')
      const hits = await ctx.memory.search({ query: '发布约定' })
      expect(hits.results.length).toBeGreaterThan(0)
      expect(hits.results[0]!.chunk.text).toContain('发布约定')
      expect(hits.results[0]!.mode).toBe('fts-only')
      expect(await ctx.memory.read(hits.results[0]!.chunk.path)).toContain('发布约定')
      expect(await ctx.memory.search({ query: '不存在的主题词' })).toEqual({ results: [], total: 0 })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('purges index rows for files deleted from disk', async () => {
    const root = await temporaryPath()
    const layout = resolveMemoryLayout('/work/alpha', root, undefined)
    const first = await mount(root)
    try {
      await first.memory.write(MemoryPath('global', 'MEMORY.md'), '# Project memory\n\nVanishing convention.')
      await first.memory.write(MemoryPath('workspace', 'MEMORY.md'), '# Workspace memory\n\nPersistent convention.')
    } finally {
      await first.fiber.dispose()
    }
    await rm(layout.globalMemoryFile)
    const second = await mount(root)
    try {
      const purged = await second.memory.search({ query: 'Vanishing' })
      expect(purged.results).toEqual([])
      const kept = await second.memory.search({ query: 'Persistent' })
      expect(kept.results.length).toBeGreaterThan(0)
    } finally {
      await second.fiber.dispose()
    }
  })

  it('indexes files that exist on disk before the provider mounts', async () => {
    const root = await temporaryPath()
    const layout = resolveMemoryLayout('/work/alpha', root, undefined)
    await ensureMemoryDirectories(layout)
    await writeMemoryFile(layout.globalMemoryFile, '# Project memory\n\nPre-seeded global convention.')
    await writeMemoryFile(join(layout.globalDir, 'other.md'), '# Other')
    await writeFile(join(layout.globalDir, 'readme.txt'), 'not markdown')
    await mkdir(join(layout.globalDir, 'nested'))
    await writeMemoryFile(join(layout.sessionsDir, '2026-08-16-demo-a1b2c3d4.md'), '# Session\n\nPre-seeded session archive.')
    await writeMemoryFile(join(layout.sessionsDir, 'bad-name.md'), '# Bad')
    await writeFile(join(layout.sessionsDir, 'meta.txt'), 'not markdown')
    await mkdir(join(layout.sessionsDir, 'nested'))

    const ctx = await mount(root)
    try {
      const global = await ctx.memory.search({ query: 'Pre-seeded global convention' })
      expect(global.results.length).toBeGreaterThan(0)
      const session = await ctx.memory.search({ query: 'Pre-seeded session archive' })
      expect(session.results.length).toBeGreaterThan(0)
      const files = await ctx.memory.list()
      expect(files.map(file => file.path).sort()).toEqual(
        ['MEMORY.md', 'sessions/2026-08-16-demo-a1b2c3d4.md'].sort(),
      )
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('prunes expired session archives when retentionDays is set', async () => {
    const root = await temporaryPath()
    const layout = resolveMemoryLayout('/work/alpha', root, undefined)
    await ensureMemoryDirectories(layout)
    const today = new Date().toISOString().slice(0, 10)
    const oldArchive = join(layout.sessionsDir, '2020-01-01-old-a1b2c3d4.md')
    const freshArchive = join(layout.sessionsDir, `${today}-fresh-b2c3d4e5.md`)
    await writeMemoryFile(layout.globalMemoryFile, '# Project memory\n\nEvergreen convention.')
    await writeMemoryFile(oldArchive, '# Session\n\nAncient convention.')
    await writeMemoryFile(freshArchive, '# Session\n\nFresh convention.')

    const ctx = new Context()
    await ctx.plugin(MarkdownMemoryService, {
      root,
      workspace: '/work/alpha',
      openAt: 'startup',
      session: { retentionDays: 30 },
    })
    try {
      await expect(readMemoryFile(oldArchive)).rejects.toMatchObject({ code: 'MEMORY_FILE_NOT_FOUND' })
      expect((await ctx.memory.search({ query: 'Ancient convention' })).results).toEqual([])
      const fresh = await ctx.memory.search({ query: 'Fresh convention' })
      expect(fresh.results.length).toBeGreaterThan(0)
      const files = await ctx.memory.list()
      expect(files.some(file => file.path.includes('2020-01-01-old'))).toBe(false)
      await expect(ctx.memory.read(MemoryPath('global', 'MEMORY.md'))).resolves.toContain('Evergreen convention.')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps session archives when retentionDays is omitted', async () => {
    const root = await temporaryPath()
    const layout = resolveMemoryLayout('/work/alpha', root, undefined)
    await ensureMemoryDirectories(layout)
    await writeMemoryFile(join(layout.sessionsDir, '2020-01-01-old-a1b2c3d4.md'), '# Session\n\nAncient convention.')
    const ctx = await mount(root)
    try {
      expect((await ctx.memory.search({ query: 'Ancient convention' })).results.length).toBeGreaterThan(0)
      await expect(readMemoryFile(join(layout.sessionsDir, '2020-01-01-old-a1b2c3d4.md'))).resolves.toContain('Ancient convention.')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('creates workspace memory from scratch when a dream pass consolidates', async () => {
    const root = await temporaryPath()
    const layout = resolveMemoryLayout('/work/alpha', root, undefined)
    await ensureMemoryDirectories(layout)
    await writeMemoryFile(join(layout.sessionsDir, '2026-08-01-one-a1111111.md'), '# Session\n\nPin Node LTS.')
    await writeMemoryFile(join(layout.sessionsDir, '2026-08-02-two-b2222222.md'), '# Session\n\nRun releases in CI.')

    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const adapter = new DreamAdapter('- Pin Node LTS.\n- Run releases in CI.')
    ctx.llm.registerAdapter(['dream-provider'], adapter)
    await ctx.plugin(MarkdownMemoryService, {
      root,
      workspace: '/work/alpha',
      openAt: 'startup',
      dream: { enabled: true, provider: 'dream-provider', model: 'dream-model', minNewArchives: 1 },
    })
    try {
      const session = Session.create(SessionId('dream-create'))
      await runDream(ctx.memory, session)
      const workspace = await ctx.memory.read(MemoryPath('workspace', 'MEMORY.md'))
      expect(workspace).toContain('# Workspace memory')
      expect(workspace).toContain('## Dream consolidation')
      expect(workspace).toContain('- Pin Node LTS.')
      expect(adapter.requests).toHaveLength(1)
      expect(adapter.requests[0]).toMatchObject({
        provider: 'dream-provider',
        model: 'dream-model',
        maxTokens: 1024,
        purpose: 'dream',
      })
      expect(adapter.requests[0]!.system).toBeTruthy()
      expect(adapter.requests[0]!.messages[0]).toMatchObject({
        role: 'user',
        source: { kind: 'plugin', plugin: 'dsh-memory-markdown' },
      })
      const dream = session.events.filter(event => event.type === 'memory/dream')
      expect(dream).toHaveLength(1)
      const payload = (dream[0] as { data: { archives: string[]; output: string } }).data
      expect(payload.archives).toEqual(['2026-08-01-one-a1111111.md', '2026-08-02-two-b2222222.md'])
      expect(payload.output).toBe('- Pin Node LTS.\n- Run releases in CI.')
      const hits = await ctx.memory.search({ query: 'Pin Node LTS' })
      expect(hits.results.length).toBeGreaterThan(0)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('appends below existing workspace memory and skips a repeat pass', async () => {
    const root = await temporaryPath()
    const layout = resolveMemoryLayout('/work/alpha', root, undefined)
    await ensureMemoryDirectories(layout)
    await writeMemoryFile(layout.workspaceMemoryFile, '# Workspace memory\n\n- curated fact')
    await writeMemoryFile(join(layout.sessionsDir, '2026-08-01-one-a1111111.md'), '# Session\n\nNew durable fact.')

    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const adapter = new DreamAdapter('- New durable fact.')
    ctx.llm.registerAdapter(['dream-provider'], adapter)
    await ctx.plugin(MarkdownMemoryService, {
      root,
      workspace: '/work/alpha',
      openAt: 'startup',
      dream: { enabled: true, provider: 'dream-provider', model: 'dream-model', minNewArchives: 1 },
    })
    try {
      const session = Session.create(SessionId('dream-append'))
      await runDream(ctx.memory, session)
      const workspace = await ctx.memory.read(MemoryPath('workspace', 'MEMORY.md'))
      expect(workspace).toContain('- curated fact')
      expect(workspace).toContain('## Dream consolidation')
      expect(workspace).toContain('- New durable fact.')
      await runDream(ctx.memory, session)
      expect(adapter.requests).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('records an empty pass without appending anything', async () => {
    const root = await temporaryPath()
    const layout = resolveMemoryLayout('/work/alpha', root, undefined)
    await ensureMemoryDirectories(layout)
    await writeMemoryFile(join(layout.sessionsDir, '2026-08-01-one-a1111111.md'), '# Session\n\nNothing new.')

    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const adapter = new DreamAdapter('')
    ctx.llm.registerAdapter(['dream-provider'], adapter)
    await ctx.plugin(MarkdownMemoryService, {
      root,
      workspace: '/work/alpha',
      openAt: 'startup',
      dream: { enabled: true, provider: 'dream-provider', model: 'dream-model', minNewArchives: 1 },
    })
    try {
      const session = Session.create(SessionId('dream-empty'))
      await runDream(ctx.memory, session)
      await expect(readMemoryFile(layout.workspaceMemoryFile)).rejects.toMatchObject({ code: 'MEMORY_FILE_NOT_FOUND' })
      const dream = session.events.filter(event => event.type === 'memory/dream')
      expect(dream).toHaveLength(1)
      expect((dream[0] as { data: { output: string } }).data.output).toBe('')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('warns and leaves archives un-consumed when the model call fails', async () => {
    const root = await temporaryPath()
    const layout = resolveMemoryLayout('/work/alpha', root, undefined)
    await ensureMemoryDirectories(layout)
    await writeMemoryFile(join(layout.sessionsDir, '2026-08-01-one-a1111111.md'), '# Session\n\nTry again.')

    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const adapter = new DreamAdapter('- fact', { kind: 'error', failure: { message: 'boom', code: 'NO_ADAPTER' } })
    ctx.llm.registerAdapter(['dream-provider'], adapter)
    await ctx.plugin(MarkdownMemoryService, {
      root,
      workspace: '/work/alpha',
      openAt: 'startup',
      dream: { enabled: true, provider: 'dream-provider', model: 'dream-model', minNewArchives: 1 },
    })
    try {
      const session = Session.create(SessionId('dream-fail'))
      await runDream(ctx.memory, session)
      await expect(readMemoryFile(layout.workspaceMemoryFile)).rejects.toMatchObject({ code: 'MEMORY_FILE_NOT_FOUND' })
      await runDream(ctx.memory, session)
      expect(adapter.requests).toHaveLength(2)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('warns when workspace memory cannot be read', async () => {
    const root = await temporaryPath()
    const layout = resolveMemoryLayout('/work/alpha', root, undefined)
    await ensureMemoryDirectories(layout)
    await mkdir(layout.workspaceMemoryFile)
    await writeMemoryFile(join(layout.sessionsDir, '2026-08-01-one-a1111111.md'), '# Session\n\nUnreadable memory.')

    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const adapter = new DreamAdapter('- fact')
    ctx.llm.registerAdapter(['dream-provider'], adapter)
    await ctx.plugin(MarkdownMemoryService, {
      root,
      workspace: '/work/alpha',
      openAt: 'startup',
      dream: { enabled: true, provider: 'dream-provider', model: 'dream-model', minNewArchives: 1 },
    })
    try {
      const session = Session.create(SessionId('dream-unreadable'))
      await runDream(ctx.memory, session)
      expect(adapter.requests).toHaveLength(0)
      expect(session.events.filter(event => event.type === 'memory/dream')).toHaveLength(0)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('honors the minNewArchives and interval gates', async () => {
    const root = await temporaryPath()
    const layout = resolveMemoryLayout('/work/alpha', root, undefined)
    await ensureMemoryDirectories(layout)
    await writeMemoryFile(join(layout.sessionsDir, '2026-08-01-one-a1111111.md'), '# Session\n\nFirst.')
    await writeMemoryFile(join(layout.sessionsDir, '2026-08-02-two-b2222222.md'), '# Session\n\nSecond.')

    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const adapter = new DreamAdapter('- consolidated')
    ctx.llm.registerAdapter(['dream-provider'], adapter)
    await ctx.plugin(MarkdownMemoryService, {
      root,
      workspace: '/work/alpha',
      openAt: 'startup',
      dream: {
        enabled: true,
        provider: 'dream-provider',
        model: 'dream-model',
        minNewArchives: 3,
        intervalHours: 24,
      },
    })
    try {
      const session = Session.create(SessionId('dream-gates'))
      await runDream(ctx.memory, session)
      expect(adapter.requests).toHaveLength(0)
      await writeMemoryFile(join(layout.sessionsDir, '2026-08-03-three-c3333333.md'), '# Session\n\nThird.')
      await runDream(ctx.memory, session)
      expect(adapter.requests).toHaveLength(1)
      await writeMemoryFile(join(layout.sessionsDir, '2026-08-04-four-d4444444.md'), '# Session\n\nFourth.')
      await runDream(ctx.memory, session)
      expect(adapter.requests).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('caps a pass at maxArchivesPerPass, selecting oldest first', async () => {
    const root = await temporaryPath()
    const layout = resolveMemoryLayout('/work/alpha', root, undefined)
    await ensureMemoryDirectories(layout)
    await writeMemoryFile(join(layout.sessionsDir, '2026-08-01-one-a1111111.md'), '# Session\n\nOldest.')
    await writeMemoryFile(join(layout.sessionsDir, '2026-08-02-two-b2222222.md'), '# Session\n\nMiddle.')
    await writeMemoryFile(join(layout.sessionsDir, '2026-08-03-three-c3333333.md'), '# Session\n\nNewest.')

    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const adapter = new DreamAdapter('- cap')
    ctx.llm.registerAdapter(['dream-provider'], adapter)
    await ctx.plugin(MarkdownMemoryService, {
      root,
      workspace: '/work/alpha',
      openAt: 'startup',
      dream: { enabled: true, provider: 'dream-provider', model: 'dream-model', minNewArchives: 1, maxArchivesPerPass: 2 },
    })
    try {
      const session = Session.create(SessionId('dream-cap'))
      await runDream(ctx.memory, session)
      const dream = session.events.filter(event => event.type === 'memory/dream')
      expect((dream[0] as { data: { archives: string[] } }).data.archives).toEqual([
        '2026-08-01-one-a1111111.md',
        '2026-08-02-two-b2222222.md',
      ])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('falls back to the session routed provider when none is configured', async () => {
    const root = await temporaryPath()
    const layout = resolveMemoryLayout('/work/alpha', root, undefined)
    await ensureMemoryDirectories(layout)
    await writeMemoryFile(join(layout.sessionsDir, '2026-08-01-one-a1111111.md'), '# Session\n\nRouted.')

    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const adapter = new DreamAdapter('- routed')
    ctx.llm.registerAdapter(['routed-provider'], adapter)
    await ctx.plugin(MarkdownMemoryService, {
      root,
      workspace: '/work/alpha',
      openAt: 'startup',
      dream: { enabled: true, minNewArchives: 1 },
    })
    try {
      const session = Session.create(SessionId('dream-route'))
      session.append('request/header', {
        header: { config: { provider: 'routed-provider', model: 'routed-model' }, system: 'x' },
        reason: 'initial',
      })
      await runDream(ctx.memory, session)
      expect(adapter.requests[0]).toMatchObject({ provider: 'routed-provider', model: 'routed-model' })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('coalesces concurrent dream passes into one call', async () => {
    const root = await temporaryPath()
    const layout = resolveMemoryLayout('/work/alpha', root, undefined)
    await ensureMemoryDirectories(layout)
    await writeMemoryFile(join(layout.sessionsDir, '2026-08-01-one-a1111111.md'), '# Session\n\nCoalesce.')

    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const adapter = new DreamAdapter('- coalesced')
    ctx.llm.registerAdapter(['dream-provider'], adapter)
    await ctx.plugin(MarkdownMemoryService, {
      root,
      workspace: '/work/alpha',
      openAt: 'startup',
      dream: { enabled: true, provider: 'dream-provider', model: 'dream-model', minNewArchives: 1 },
    })
    try {
      const session = Session.create(SessionId('dream-coalesce'))
      const service = ctx.memory as unknown as { _maybeDream(session: Session): Promise<void> }
      const first = service._maybeDream(session)
      const second = service._maybeDream(session)
      expect(second).toBe(first)
      await first
      expect(adapter.requests).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('skips the dream pass when disabled, without llm, without a route, or never-open', async () => {
    const disabledCtx = await mount(await temporaryPath())
    const disabledAdapter = new DreamAdapter('- x')
    await disabledCtx.plugin(LlmRuntime)
    disabledCtx.llm.registerAdapter(['dream-provider'], disabledAdapter)
    try {
      await runDream(disabledCtx.memory, Session.create(SessionId('dream-disabled')))
      expect(disabledAdapter.requests).toHaveLength(0)
    } finally {
      await disabledCtx.fiber.dispose()
    }

    const noLlmCtx = new Context()
    await noLlmCtx.plugin(MarkdownMemoryService, {
      root: await temporaryPath(),
      workspace: '/work/alpha',
      openAt: 'startup',
      dream: { enabled: true, provider: 'dream-provider', model: 'dream-model', minNewArchives: 1 },
    })
    const warn = vi.spyOn(noLlmCtx.logger, 'warn')
    try {
      await runDream(noLlmCtx.memory, Session.create(SessionId('dream-no-llm')))
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('llm service is not loaded'))
    } finally {
      await noLlmCtx.fiber.dispose()
    }

    const noRouteCtx = new Context()
    await noRouteCtx.plugin(LlmRuntime)
    const noRouteAdapter = new DreamAdapter('- x')
    noRouteCtx.llm.registerAdapter(['dream-provider'], noRouteAdapter)
    await noRouteCtx.plugin(MarkdownMemoryService, {
      root: await temporaryPath(),
      workspace: '/work/alpha',
      openAt: 'startup',
      dream: { enabled: true, minNewArchives: 1 },
    })
    try {
      await runDream(noRouteCtx.memory, Session.create(SessionId('dream-no-route')))
      expect(noRouteAdapter.requests).toHaveLength(0)
    } finally {
      await noRouteCtx.fiber.dispose()
    }

    const neverCtx = new Context()
    await neverCtx.plugin(LlmRuntime)
    const neverAdapter = new DreamAdapter('- x')
    neverCtx.llm.registerAdapter(['dream-provider'], neverAdapter)
    await neverCtx.plugin(MarkdownMemoryService, {
      root: await temporaryPath(),
      workspace: '/work/alpha',
      openAt: 'never',
      dream: { enabled: true, provider: 'dream-provider', model: 'dream-model', minNewArchives: 1 },
    })
    try {
      await runDream(neverCtx.memory, Session.create(SessionId('dream-never')))
      expect(neverAdapter.requests).toHaveLength(0)
    } finally {
      await neverCtx.fiber.dispose()
    }
  })

  it('loads and reconciles the consumed set across passes', async () => {
    const root = await temporaryPath()
    const layout = resolveMemoryLayout('/work/alpha', root, undefined)
    await ensureMemoryDirectories(layout)
    const index = join(layout.root, 'index.sqlite')
    const seeded = await openMemoryDatabase(index, 'wal')
    try {
      writeMeta(seeded, MEMORY_DREAM_META_CONSUMED, JSON.stringify(['2026-08-01-one-a1111111.md', 'stale-00000000.md', 42]))
    } finally {
      seeded.close()
    }
    await writeMemoryFile(join(layout.sessionsDir, '2026-08-01-one-a1111111.md'), '# Session\n\nConsumed.')
    await writeMemoryFile(join(layout.sessionsDir, '2026-08-02-two-b2222222.md'), '# Session\n\nFresh.')

    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const adapter = new DreamAdapter('- fresh')
    ctx.llm.registerAdapter(['dream-provider'], adapter)
    await ctx.plugin(MarkdownMemoryService, {
      root,
      workspace: '/work/alpha',
      openAt: 'startup',
      dream: { enabled: true, provider: 'dream-provider', model: 'dream-model', minNewArchives: 1 },
    })
    try {
      const session = Session.create(SessionId('dream-reconcile'))
      await runDream(ctx.memory, session)
      const dream = session.events.filter(event => event.type === 'memory/dream')
      expect((dream[0] as { data: { archives: string[] } }).data.archives).toEqual(['2026-08-02-two-b2222222.md'])
      const observed = await openMemoryDatabase(index, 'wal')
      try {
        const saved = JSON.parse(readMeta(observed, MEMORY_DREAM_META_CONSUMED) ?? '[]') as string[]
        expect(saved).toEqual(['2026-08-01-one-a1111111.md', '2026-08-02-two-b2222222.md'])
      } finally {
        observed.close()
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('refreshes the index when a watched memory file changes externally', async () => {
    const root = await temporaryPath()
    const layout = resolveMemoryLayout('/work/alpha', root, undefined)
    const ctx = new Context()
    await ctx.plugin(MarkdownMemoryService, {
      root,
      workspace: '/work/alpha',
      openAt: 'startup',
      watcher: { enabled: true, debounceMs: 10, pollIntervalMs: 50 },
    })
    try {
      const global = MemoryPath('global', 'MEMORY.md')
      await ctx.memory.write(global, '# Project memory\n\nOld convention.')
      await writeFile(layout.globalMemoryFile, '# Project memory\n\nNew convention.')
      await waitFor(async () => {
        const hits = await ctx.memory.search({ query: 'New convention' })
        return hits.results.length > 0
      })
      expect((await ctx.memory.search({ query: 'New convention' })).results[0]!.chunk.text).toContain('New convention')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('purges a watched memory file deleted externally', async () => {
    const root = await temporaryPath()
    const layout = resolveMemoryLayout('/work/alpha', root, undefined)
    const ctx = new Context()
    await ctx.plugin(MarkdownMemoryService, {
      root,
      workspace: '/work/alpha',
      openAt: 'startup',
      watcher: { enabled: true, debounceMs: 10, pollIntervalMs: 50 },
    })
    try {
      const global = MemoryPath('global', 'MEMORY.md')
      await ctx.memory.write(global, '# Project memory\n\nVanishing convention.')
      await waitFor(async () => {
        const hits = await ctx.memory.search({ query: 'Vanishing convention' })
        return hits.results.length > 0
      })
      await rm(layout.globalMemoryFile)
      await waitFor(async () => {
        const hits = await ctx.memory.search({ query: 'Vanishing convention' })
        return hits.results.length === 0
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('does not refresh on external edits when the watcher is off', async () => {
    const root = await temporaryPath()
    const layout = resolveMemoryLayout('/work/alpha', root, undefined)
    const ctx = await mount(root)
    try {
      const global = MemoryPath('global', 'MEMORY.md')
      await ctx.memory.write(global, '# Project memory\n\nOld convention.')
      await writeFile(layout.globalMemoryFile, '# Project memory\n\nNew convention.')
      await new Promise(resolve => setTimeout(resolve, 120))
      const hits = await ctx.memory.search({ query: 'New convention' })
      expect(hits).toEqual({ results: [], total: 0 })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('picks up external edits through the watcher even when the index opens lazily', async () => {
    const root = await temporaryPath()
    const layout = resolveMemoryLayout('/work/alpha', root, undefined)
    const ctx = new Context()
    await ctx.plugin(MarkdownMemoryService, {
      root,
      workspace: '/work/alpha',
      openAt: 'first-search',
      watcher: { enabled: true, debounceMs: 10, pollIntervalMs: 30 },
    })
    try {
      await writeMemoryFile(layout.globalMemoryFile, '# Project memory\n\nLazy convention.')
      await new Promise(resolve => setTimeout(resolve, 80))
      const hits = await ctx.memory.search({ query: 'Lazy convention' })
      expect(hits.results.length).toBeGreaterThan(0)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('disposes the watcher with the fiber and remounts cleanly', async () => {
    const root = await temporaryPath()
    const first = new Context()
    await first.plugin(MarkdownMemoryService, {
      root,
      workspace: '/work/alpha',
      openAt: 'startup',
      watcher: { enabled: true, debounceMs: 10, pollIntervalMs: 30 },
    })
    await first.fiber.dispose()
    const second = new Context()
    await second.plugin(MarkdownMemoryService, {
      root,
      workspace: '/work/alpha',
      openAt: 'startup',
      watcher: { enabled: true, debounceMs: 10, pollIntervalMs: 30 },
    })
    try {
      await second.memory.write(MemoryPath('global', 'MEMORY.md'), '# Project memory\n\nReloaded.')
      expect((await second.memory.search({ query: 'Reloaded' })).results.length).toBeGreaterThan(0)
    } finally {
      await second.fiber.dispose()
    }
  })

  it('loads a file on read when it was not cached at open', async () => {
    const root = await temporaryPath()
    const layout = resolveMemoryLayout('/work/alpha', root, undefined)
    const ctx = await mount(root)
    try {
      await writeMemoryFile(layout.workspaceMemoryFile, '# Workspace memory\n\nLate file convention.')
      await expect(ctx.memory.read(MemoryPath('workspace', 'MEMORY.md'))).resolves.toContain('Late file convention')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('skips candidates scoring below the requested minimum', async () => {
    const ctx = await mount(await temporaryPath())
    try {
      const global = MemoryPath('global', 'MEMORY.md')
      const paragraph = `${'deployment convention for servers and nodes. '.repeat(40)}\n\n`
      await ctx.memory.write(global, `# Project memory\n\n${paragraph}${paragraph}`)
      const hits = await ctx.memory.search({ query: 'deployment', minScore: 0.9 })
      expect(hits.results.length).toBe(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('closes the index idempotently', async () => {
    const ctx = await mount(await temporaryPath())
    try {
      const service = ctx.memory as unknown as MarkdownMemoryService
      await service.close()
      await service.close()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('wraps index-open failures in the typed config error', async () => {
    const blocked = await mkdtemp(join(tmpdir(), 'dsh-memory-'))
    temporaryDirectories.push(blocked)
    const ctx = new Context()
    await expect(ctx.plugin(MarkdownMemoryService, {
      root: await temporaryPath(),
      workspace: '/work/alpha',
      path: blocked,
      openAt: 'startup',
    })).rejects.toThrow(/failed to open/)
  })

  it('reindexes files written before the first search opens the index', async () => {
    const ctx = new Context()
    await ctx.plugin(MarkdownMemoryService, {
      root: await temporaryPath(),
      workspace: '/work/alpha',
      openAt: 'first-search',
    })
    try {
      const global = MemoryPath('global', 'MEMORY.md')
      await ctx.memory.write(global, '# Project memory\n\nDeployment convention: pin Node LTS.')
      const hits = await ctx.memory.search({ query: 'Deployment convention' })
      expect(hits.results.length).toBeGreaterThan(0)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('preserves chunk creation timestamps across reindexes of unchanged content', async () => {
    const ctx = await mount(await temporaryPath())
    try {
      const global = MemoryPath('global', 'MEMORY.md')
      const content = '# Project memory\n\nDeployment convention: pin Node LTS.'
      await ctx.memory.write(global, content)
      const service = ctx.memory as unknown as MarkdownMemoryService
      const db = service['_db']!
      const createdBefore = (db.prepare('SELECT created_at FROM chunks WHERE path = ?')
        .get(global) as { created_at: number }).created_at

      await ctx.memory.write(global, content)
      const createdAfter = (db.prepare('SELECT created_at FROM chunks WHERE path = ?')
        .get(global) as { created_at: number }).created_at
      expect(createdAfter).toBe(createdBefore)

      await ctx.memory.write(global, `${content}\n\nA new conclusion.`)
      const changedCreated = (db.prepare('SELECT created_at FROM chunks WHERE path = ?')
        .get(global) as { created_at: number }).created_at
      expect(changedCreated).toBeGreaterThanOrEqual(createdBefore)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('preserves chunk access counts across reindexes of unchanged content', async () => {
    const ctx = await mount(await temporaryPath())
    try {
      const global = MemoryPath('global', 'MEMORY.md')
      const content = '# Project memory\n\nDeployment convention: pin Node LTS.'
      await ctx.memory.write(global, content)
      await ctx.memory.search({ query: 'Deployment convention' })
      const service = ctx.memory as unknown as MarkdownMemoryService
      const db = service['_db']!
      const accessBefore = (db.prepare('SELECT access_count FROM chunks WHERE path = ?')
        .get(global) as { access_count: number }).access_count
      expect(accessBefore).toBeGreaterThan(0)

      await ctx.memory.write(global, content)
      const accessAfter = (db.prepare('SELECT access_count FROM chunks WHERE path = ?')
        .get(global) as { access_count: number }).access_count
      expect(accessAfter).toBe(accessBefore)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps content-free chunks out of search results', async () => {
    const ctx = await mount(await temporaryPath())
    try {
      const global = MemoryPath('global', 'MEMORY.md')
      await ctx.memory.write(global, '# Project memory\n\nThis file is managed by the harness.')
      const hits = await ctx.memory.search({ query: 'managed' })
      expect(hits.results).toEqual([])
      expect(hits.total).toBe(0)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('injects real chunks ahead of content-free ones within the result cap', async () => {
    const ctx = await mount(await temporaryPath())
    try {
      const global = MemoryPath('global', 'MEMORY.md')
      const workspace = MemoryPath('workspace', 'MEMORY.md')
      await ctx.memory.write(global, '# Project memory\n\nThis file is managed by the harness.')
      await ctx.memory.write(workspace, '# Workspace memory\n\nDeployment convention: pin Node LTS.')
      const service = ctx.memory as unknown as MarkdownMemoryService
      const db = service['_db']!
      db.prepare('UPDATE chunks SET access_count = 5 WHERE path = ?').run(global)

      const injected = await ctx.memory.inject({ maxChunks: 1 })
      expect(injected.map(chunk => chunk.path)).toEqual([workspace])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('finds real chunks behind content-free matches within the amplified candidate window', async () => {
    const ctx = await mount(await temporaryPath())
    try {
      const global = MemoryPath('global', 'MEMORY.md')
      const workspace = MemoryPath('workspace', 'MEMORY.md')
      const filler = 'the cluster spans regions with zones, replicas, observability, telemetry, and alerting wired through the ops pipeline. '
      await ctx.memory.write(global, '# Project memory\n\nThis file is managed by the harness.')
      await ctx.memory.write(workspace, `# Workspace memory\n\n${filler}managed ${filler}`)

      const hits = await ctx.memory.search({ query: 'managed', limit: 1 })
      expect(hits.results.map(result => result.chunk.path)).toEqual([workspace])
      expect(hits.total).toBe(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('surfaces durable access metadata through readChunks', async () => {
    const ctx = await mount(await temporaryPath())
    try {
      const global = MemoryPath('global', 'MEMORY.md')
      await ctx.memory.write(global, '# Project memory\n\nDeployment convention: pin Node LTS.')
      await ctx.memory.search({ query: 'Deployment convention' })
      const chunks = await ctx.memory.readChunks(global)
      expect(chunks.some(chunk => chunk.accessCount > 0)).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reads chunks from the file when the index is never opened', async () => {
    const root = await temporaryPath()
    const ctx = new Context()
    await ctx.plugin(MarkdownMemoryService, {
      root,
      workspace: '/work/alpha',
      openAt: 'never',
    })
    try {
      const global = MemoryPath('global', 'MEMORY.md')
      await ctx.memory.write(global, '# Project memory\n\nDeployment convention: pin Node LTS.')
      const chunks = await ctx.memory.readChunks(global)
      expect(chunks.length).toBeGreaterThan(0)
      expect(chunks.some(chunk => chunk.accessCount === 0)).toBe(true)
      await expect(ctx.memory.search({ query: 'Deployment convention' })).rejects.toThrow(/search is disabled/)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects reading a missing file and invalid search bounds', async () => {
    const ctx = await mount(await temporaryPath())
    try {
      const missing = MemoryPath('global', 'MEMORY.md')
      await expect(ctx.memory.read(missing)).rejects.toMatchObject({ code: 'MEMORY_FILE_NOT_FOUND' })
      await expect(ctx.memory.search({ query: 'x', limit: 0 })).rejects.toMatchObject({
        code: 'MEMORY_INVALID_CONFIG',
      })
      await expect(ctx.memory.inject({ maxChunks: 0 })).rejects.toMatchObject({
        code: 'MEMORY_INVALID_CONFIG',
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('honors openAt first-search and never', async () => {
    const lazyCtx = new Context()
    await lazyCtx.plugin(MarkdownMemoryService, {
      root: await temporaryPath(),
      workspace: '/work/alpha',
      openAt: 'first-search',
    })
    try {
      const page = await lazyCtx.memory.search({ query: 'anything' })
      expect(page.total).toBe(0)
      await expect(lazyCtx.memory.search({ query: '' })).resolves.toBeDefined()
    } finally {
      await lazyCtx.fiber.dispose()
    }

    const neverCtx = new Context()
    await neverCtx.plugin(MarkdownMemoryService, {
      root: await temporaryPath(),
      workspace: '/work/alpha',
      openAt: 'never',
      watcher: { enabled: true },
    })
    try {
      await expect(neverCtx.memory.search({ query: 'x' })).rejects.toMatchObject({
        code: 'MEMORY_INVALID_CONFIG',
      })
    } finally {
      await neverCtx.fiber.dispose()
    }
  })

  it('rejects blank workspaces and invalid chunk and watcher config', async () => {
    const ctx = new Context()
    await expect(ctx.plugin(MarkdownMemoryService, {
      root: await temporaryPath(),
      workspace: '   ',
    })).rejects.toThrow(/workspace must not be blank/)
    const invalid = new Context()
    await expect(invalid.plugin(MarkdownMemoryService, {
      root: await temporaryPath(),
      workspace: '/w',
      index: { maxChunkChars: 0 },
    })).rejects.toThrow(/maxChunkChars/)
    const badWatcher = new Context()
    await expect(badWatcher.plugin(MarkdownMemoryService, {
      root: await temporaryPath(),
      workspace: '/w',
      watcher: { enabled: true, debounceMs: 0 },
    })).rejects.toThrow(/debounceMs/)
    const badRetention = new Context()
    await expect(badRetention.plugin(MarkdownMemoryService, {
      root: await temporaryPath(),
      workspace: '/w',
      session: { retentionDays: 0 },
    })).rejects.toThrow(/retentionDays/)
    const badDreamInterval = new Context()
    await expect(badDreamInterval.plugin(MarkdownMemoryService, {
      root: await temporaryPath(),
      workspace: '/w',
      dream: { intervalHours: 0 },
    })).rejects.toThrow(/intervalHours/)
    const badDreamPair = new Context()
    await expect(badDreamPair.plugin(MarkdownMemoryService, {
      root: await temporaryPath(),
      workspace: '/w',
      dream: { enabled: true, provider: 'p' },
    })).rejects.toThrow(/supplied together/)
  })

  it('defends chunk and lifecycle config when direct construction bypasses the schema', () => {
    expect(() => new MarkdownMemoryService(new Context(), {
      workspace: '/w',
      index: { maxChunkChars: 0 },
    })).toThrow(/maxChunkChars must be a positive safe integer/)
    expect(() => new MarkdownMemoryService(new Context(), {
      workspace: '/w',
      index: { chunkOverlapChars: -1 },
    })).toThrow(/chunkOverlapChars must be a non-negative safe integer/)
    expect(() => new MarkdownMemoryService(new Context(), {
      workspace: '/w',
      openAt: 'invalid' as never,
    })).toThrow(/openAt is not supported/)
    expect(() => new MarkdownMemoryService(new Context(), {
      workspace: '/w',
      journalMode: 'invalid' as never,
    })).toThrow(/journalMode is not supported/)
    expect(() => new MarkdownMemoryService(new Context(), {
      workspace: '/w',
      watcher: { enabled: true, debounceMs: 0 },
    })).toThrow(/watcher\.debounceMs must be a positive safe integer/)
    expect(() => new MarkdownMemoryService(new Context(), {
      workspace: '/w',
      watcher: { enabled: true, pollIntervalMs: 1.5 },
    })).toThrow(/watcher\.pollIntervalMs must be a positive safe integer/)
    expect(() => new MarkdownMemoryService(new Context(), {
      workspace: '/w',
      session: { retentionDays: 1.5 },
    })).toThrow(/retentionDays must be a positive safe integer/)
    expect(() => new MarkdownMemoryService(new Context(), {
      workspace: '/w',
      dream: { intervalHours: 0 },
    })).toThrow(/dream\.intervalHours must be a positive safe integer/)
    expect(() => new MarkdownMemoryService(new Context(), {
      workspace: '/w',
      dream: { minNewArchives: 1.5 },
    })).toThrow(/dream\.minNewArchives must be a positive safe integer/)
    expect(() => new MarkdownMemoryService(new Context(), {
      workspace: '/w',
      dream: { enabled: true, provider: 'p' },
    })).toThrow(/dream\.provider and dream\.model must be supplied together/)
    expect(() => new MarkdownMemoryService(new Context(), {
      workspace: '/w',
      dream: { enabled: true, provider: '', model: 'm' },
    })).toThrow(/dream\.provider and dream\.model must be non-empty strings/)
    expect(() => new MarkdownMemoryService(new Context(), {
      workspace: '/w',
      dream: { enabled: true, provider: 'p', model: '' },
    })).toThrow(/dream\.provider and dream\.model must be non-empty strings/)
    expect(() => new MarkdownMemoryService(new Context(), {
      workspace: '/w',
      watcher: { enabled: true },
    })).not.toThrow()
    expect(() => new MarkdownMemoryService(new Context(), {
      workspace: '/w',
      session: { retentionDays: 1 },
    })).not.toThrow()
    const valid = new MarkdownMemoryService(new Context(), { workspace: '/w' })
    expect(valid).toBeInstanceOf(MarkdownMemoryService)
  })
})
