import { describe, expect, it } from 'vitest'
import {
  MemoryError,
  MemoryPath,
  applySourceAndAccess,
  applyTemporalDecay,
  chunkHash,
  chunkMarkdown,
  isContentFree,
  isEvergreenScope,
  isSessionArchivePath,
  isWorkspaceMemoryPath,
  mergeScores,
  resolveSearchLimits,
  scopeOfPath,
  type MemoryChunk,
  type MemorySearchConfig,
} from '../src/index.ts'

const EVERGREEN_DECAY = { enabled: true, halfLifeDays: 30 }

function chunk(over: Partial<MemoryChunk> = {}): MemoryChunk {
  return {
    id: 'chunk-1' as never,
    path: MemoryPath('global', 'MEMORY.md'),
    startLine: 0,
    endLine: 1,
    text: 'Deployment convention: pin Node to LTS.',
    source: 'global',
    accessCount: 0,
    createdAt: Date.now(),
    ...over,
  }
}

function config(over: Partial<MemorySearchConfig> = {}): MemorySearchConfig {
  return {
    maxResults: 10,
    minScore: 0.1,
    textWeight: 1,
    vectorWeight: 1,
    mmrEnabled: false,
    temporalDecay: EVERGREEN_DECAY,
    sourceWeights: { global: 1, workspace: 1, session: 1 },
    ...over,
  }
}

describe('MemoryPath', () => {
  it('accepts global, workspace, and session archive paths', () => {
    expect(MemoryPath('global', 'MEMORY.md')).toBe('MEMORY.md')
    expect(MemoryPath('workspace', 'MEMORY.md')).toBe('workspace/MEMORY.md')
    expect(MemoryPath('session', 'sessions', '2026-08-16-demo-a1b2c3d4.md')).toBe(
      'sessions/2026-08-16-demo-a1b2c3d4.md',
    )
  })

  it('rejects empty, mis-scoped, and unanchored paths', () => {
    expect(() => MemoryPath('global')).toThrow(MemoryError)
    expect(() => MemoryPath('global', 'notes.md')).toThrow(/not an allowed memory path/)
    expect(() => MemoryPath('workspace', 'notes.md')).toThrow(/not an allowed memory path/)
    expect(() => MemoryPath('session', 'sessions', 'scrap.md')).toThrow(/not an allowed memory path/)
    expect(() => MemoryPath('session', 'other', '2026-08-16-demo-a1b2c3d4.md')).toThrow(/not an allowed memory path/)
    expect(() => MemoryPath('global', 'sessions', '2026-08-16-demo-a1b2c3d4.md')).toThrow(/not an allowed memory path/)
  })

  it('classifies path kinds and scopes', () => {
    const session = MemoryPath('session', 'sessions', '2026-08-16-demo-a1b2c3d4.md')
    const workspace = MemoryPath('workspace', 'MEMORY.md')
    expect(isSessionArchivePath(session)).toBe(true)
    expect(isSessionArchivePath(workspace)).toBe(false)
    expect(isWorkspaceMemoryPath(workspace)).toBe(true)
    expect(scopeOfPath(session)).toBe('session')
    expect(scopeOfPath(workspace)).toBe('workspace')
    expect(scopeOfPath(MemoryPath('global', 'MEMORY.md'))).toBe('global')
  })
})

describe('chunkMarkdown', () => {
  it('keeps short documents as one chunk', () => {
    const chunks = chunkMarkdown('# Project memory\n\nDeploy on Fridays.', {
      maxChunkChars: 800,
      chunkOverlapChars: 120,
    })
    expect(chunks.length).toBe(1)
    expect(chunks[0]).toMatchObject({ startLine: 0, endLine: 3 })
  })

  it('splits documents across headers with ancestor context', () => {
    const chunks = chunkMarkdown(
      '# Top\n\n## One\n\nparagraph one\n\n## Two\n\nparagraph two\n\n### Two dot one\n\ndeep detail',
      { maxChunkChars: 60, chunkOverlapChars: 10 },
    )
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.some(chunk => chunk.text.includes('## One'))).toBe(true)
    expect(chunks.some(chunk => chunk.text.includes('## Two'))).toBe(true)
  })

  it('normalizes window path separators and yields stable hashes', () => {
    const text = '# Stable\n\ncontent'
    const first = chunkMarkdown(text, { maxChunkChars: 800, chunkOverlapChars: 120 })
    const second = chunkMarkdown(text, { maxChunkChars: 800, chunkOverlapChars: 120 })
    expect(chunkHash(first[0]!.text)).toBe(chunkHash(second[0]!.text))
    expect(chunkHash(first[0]!.text)).toMatch(/^[0-9a-f]{24}$/)
  })
})

describe('scoring helpers', () => {
  it('recognizes evergreen scopes and content-free chunks', () => {
    expect(isEvergreenScope('global')).toBe(true)
    expect(isEvergreenScope('workspace')).toBe(true)
    expect(isEvergreenScope('session')).toBe(false)
    expect(isContentFree('', 'global')).toBe(true)
    expect(isContentFree('# Heading only', 'global')).toBe(true)
    expect(isContentFree('A real conclusion.', 'global')).toBe(false)
  })

  it('applies temporal decay only to session chunks', () => {
    const now = Date.now()
    const evergreen = applyTemporalDecay(1, chunk({ source: 'global' }), now, EVERGREEN_DECAY)
    expect(evergreen).toBe(1)
    const fresh = applyTemporalDecay(1, chunk({ source: 'session' }), now, EVERGREEN_DECAY)
    expect(fresh).toBeCloseTo(1)
    const old = applyTemporalDecay(
      1,
      chunk({ source: 'session', createdAt: now - 30 * 86_400_000 }),
      now,
      EVERGREEN_DECAY,
    )
    expect(old).toBeCloseTo(0.5, 3)
  })

  it('applies source weights and access boost, then merges scores', () => {
    const scored = applySourceAndAccess(
      0.8,
      'session',
      2,
      { global: 1, workspace: 1, session: 1.5 },
    )
    expect(scored).toBeGreaterThan(0.8)
    const merged = mergeScores(0.6, 0.4, 0.5, 0.5)
    expect(merged).toBeCloseTo(0.5)
  })
})

describe('resolveSearchLimits', () => {
  it('defaults to the service config and rejects invalid bounds', () => {
    const service = { config: { search: config() } } as never
    expect(resolveSearchLimits(service, { query: 'x' })).toEqual({ limit: 10, minScore: 0.1 })
    expect(resolveSearchLimits(service, { query: 'x', limit: 3, minScore: 0.5 }))
      .toEqual({ limit: 3, minScore: 0.5 })
    expect(() => resolveSearchLimits(service, { query: 'x', limit: 0 })).toThrow(MemoryError)
    expect(() => resolveSearchLimits(service, { query: 'x', limit: 1.5 })).toThrow(MemoryError)
    expect(() => resolveSearchLimits(service, { query: 'x', minScore: 2 })).toThrow(MemoryError)
    expect(() => resolveSearchLimits(service, { query: 'x', minScore: -1 })).toThrow(MemoryError)
  })

  it('rejects aborted signals', () => {
    const service = { config: { search: config() } } as never
    const signal = new AbortController()
    signal.abort()
    expect(() => resolveSearchLimits(service, { query: 'x', signal: signal.signal }))
      .toThrow(/aborted/)
  })
})
