import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { MemoryPath, type MemoryChunk, type MemoryChunkId } from '@deepseek-ai/dsh-memory'
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
import { extractKeywords, filterContentFree, keywordScan, makeSnippet, scoreRow, rowToChunk } from '../src/query.ts'
import { openMemoryDatabase } from '../src/schema.ts'

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

describe('layout', () => {
  it('resolves roots, workspace hash, and scoped file paths', () => {
    const root = 'C:/memory-root'
    const layout = resolveMemoryLayout('C:/work/alpha', root, undefined)
    const hash = workspaceHashOf('C:/work/alpha')
    expect(layout.root).toBe(join('C:/memory-root'))
    expect(layout.globalDir).toBe(join('C:/memory-root'))
    expect(layout.globalMemoryFile).toBe(join('C:/memory-root', 'MEMORY.md'))
    expect(layout.workspaceDir).toBe(join('C:/memory-root', hash))
    expect(layout.workspaceMemoryFile).toBe(join('C:/memory-root', hash, 'MEMORY.md'))
    expect(layout.sessionsDir).toBe(join('C:/memory-root', hash, 'sessions'))
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
    })
    try {
      await expect(neverCtx.memory.search({ query: 'x' })).rejects.toMatchObject({
        code: 'MEMORY_INVALID_CONFIG',
      })
    } finally {
      await neverCtx.fiber.dispose()
    }
  })

  it('rejects blank workspaces and invalid chunk config', async () => {
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
    const valid = new MarkdownMemoryService(new Context(), { workspace: '/w' })
    expect(valid).toBeInstanceOf(MarkdownMemoryService)
  })
})
