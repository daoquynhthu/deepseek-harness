import { describe, expect, it } from 'vitest'
import { MemoryServiceConfig } from '../src/config.ts'
import { attributeChunk, chunkHash, chunkMarkdown, headerLevel } from '../src/chunker.ts'
import {
  applySourceAndAccess,
  applyTemporalDecay,
  isContentFree,
  isEvergreenScope,
} from '../src/scoring.ts'
import { MemoryPath } from '../src/path.ts'

const CHUNK_CONFIG = { maxChunkChars: 800, chunkOverlapChars: 120 }

describe('config validation edge cases', () => {
  it.each([
    [{ maxResults: 0 }, /maxResults/],
    [{ maxResults: 1.5 }, /maxResults/],
    [{ minScore: -0.1 }, /minScore/],
    [{ minScore: 1.1 }, /minScore/],
    [{ halfLifeDays: 0 }, /halfLifeDays/],
    [{ halfLifeDays: -5 }, /halfLifeDays/],
    [{ sourceWeights: { global: -1 } }, /source weight/],
    [{ sourceWeights: { workspace: Number.NaN } }, /source weight/],
    [{ candidateMultiplier: 0 }, /candidateMultiplier/],
    [{ candidateMultiplier: 1.5 }, /candidateMultiplier/],
    [{ candidateMultiplier: -2 }, /candidateMultiplier/],
  ] as const)('rejects invalid config %j', (config, message) => {
    expect(() => new MemoryServiceConfig(config)).toThrow(message)
  })

  it('freezes resolved search configuration and defaults source weights', () => {
    const config = new MemoryServiceConfig()
    expect(config.search.maxResults).toBe(10)
    expect(config.search.minScore).toBe(0.1)
    expect(config.search.temporalDecay).toEqual({ enabled: true, halfLifeDays: 30 })
    expect(config.search.candidateMultiplier).toBe(3)
    expect(config.sourceWeights).toEqual({ global: 1, workspace: 1, session: 1 })
    expect(Object.isFrozen(config.search)).toBe(true)
    expect(Object.isFrozen(config.search.temporalDecay)).toBe(true)
  })

  it('accepts explicit values across every field', () => {
    const config = new MemoryServiceConfig({
      maxResults: 3,
      minScore: 0.5,
      temporalDecayEnabled: false,
      halfLifeDays: 7,
      sourceWeights: { session: 2 },
      candidateMultiplier: 5,
    })
    expect(config.search.maxResults).toBe(3)
    expect(config.search.temporalDecay).toEqual({ enabled: false, halfLifeDays: 7 })
    expect(config.search.candidateMultiplier).toBe(5)
    expect(config.sourceWeights.session).toBe(2)
    expect(config.sourceWeights.global).toBe(1)
  })
})

describe('chunker coverage edges', () => {
  it('returns no chunks for empty content', () => {
    expect(chunkMarkdown('', CHUNK_CONFIG)).toEqual([])
  })

  it('splits oversized sections across paragraphs and lines with overlap', () => {
    const chunks = chunkMarkdown(
      '# Big\n\n'
      + 'alpha aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n'
      + 'beta bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n'
      + 'gamma cccccccccccccccccccccccccccccccccccccccccccccc',
      { maxChunkChars: 60, chunkOverlapChars: 12 },
    )
    expect(chunks.length).toBeGreaterThan(1)
    const joined = chunks.map(chunk => chunk.text).join('\n')
    expect(joined).toContain('beta')
    expect(chunks.every(chunk => chunk.startLine < chunk.endLine)).toBe(true)
  })

  it('splits with zero overlap and long single lines', () => {
    const chunks = chunkMarkdown(
      'one\n'
      + 'two\n'
      + 'three\n'
      + 'four',
      { maxChunkChars: 12, chunkOverlapChars: 0 },
    )
    expect(chunks.length).toBeGreaterThan(1)
  })

  it('flushes oversized sections at paragraph boundaries', () => {
    const chunks = chunkMarkdown(
      'section one paragraph that is long enough to exceed the bound\n'
      + '\n'
      + 'section two with a shorter paragraph\n'
      + '\n'
      + 'section three tail',
      { maxChunkChars: 40, chunkOverlapChars: 6 },
    )
    expect(chunks.length).toBeGreaterThan(2)
    const first = chunks[0]!.text
    const tail = chunks[1]!.text
    expect(first).toContain('section one')
    expect(tail).toContain('section two')
    expect(chunks.at(-1)!.text).toContain('section three')
  })

  it('keeps a single line when a split has no preceding newline', () => {
    const chunks = chunkMarkdown(
      'a line that is far too long to fit inside the configured chunk bound at all\n'
      + 'second line\n'
      + 'third line',
      { maxChunkChars: 20, chunkOverlapChars: 0 },
    )
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks[0]!.text).toContain('far too long')
  })

  it('splits one oversized line onto its own chunk boundary', () => {
    const chunks = chunkMarkdown(
      'short line\n'
      + 'another line that far exceeds the configured chunk bound with no embedded break\n'
      + 'tail line',
      { maxChunkChars: 18, chunkOverlapChars: 0 },
    )
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.some(chunk => chunk.text.includes('another line'))).toBe(true)
  })

  it('splits a leading oversized line with no prior newline', () => {
    const chunks = chunkMarkdown(
      '\n'
      + 'one very long oversized line that cannot fit the configured bound at all\n'
      + 'tail',
      { maxChunkChars: 16, chunkOverlapChars: 0 },
    )
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.some(chunk => chunk.text.includes('very long'))).toBe(true)
  })

  it('ends without a trailing chunk when content stops exactly at a paragraph flush', () => {
    const chunks = chunkMarkdown(
      'first paragraph long enough to exceed the small bound and then some\n'
      + '\n',
      { maxChunkChars: 30, chunkOverlapChars: 0 },
    )
    expect(chunks.length).toBe(1)
  })

  it('keeps the whole document when a header section stays within bounds', () => {
    const chunks = chunkMarkdown('## One\n\nbody', CHUNK_CONFIG)
    expect(chunks.length).toBe(1)
    expect(chunks[0]!.text).toContain('## One')
  })

  it('classifies header lines and non-headers', () => {
    expect(headerLevel('# h')).toBe(1)
    expect(headerLevel('### h')).toBe(3)
    expect(headerLevel('####### h')).toBe(7)
    expect(headerLevel('#not-a-header')).toBeUndefined()
    expect(headerLevel('not a header')).toBeUndefined()
  })

  it('attributions extract chunks with scope, path, and creation time', () => {
    const path = MemoryPath('global', 'MEMORY.md')
    const extracted = chunkMarkdown('A lasting conclusion.', CHUNK_CONFIG)[0]!
    const chunk = attributeChunk(extracted, path, 'global', 1234)
    expect(chunk.path).toBe(path)
    expect(chunk.source).toBe('global')
    expect(chunk.createdAt).toBe(1234)
    expect(chunk.id).toBe(chunkHash(extracted.text))
    expect(chunk.accessCount).toBe(0)
  })
})

describe('scoring coverage edges', () => {
  it('strips HTML comments including unterminated ones', () => {
    expect(isContentFree('<!-- hidden -->\n\n# Only a header', 'global')).toBe(true)
    expect(isContentFree('<!-- unterminated', 'global')).toBe(true)
  })

  it('recognizes scaffold templates and rejects real content', () => {
    expect(isContentFree('# Project memory\n\nThis file is managed by the harness.', 'global')).toBe(true)
    expect(isContentFree('# Project memory\n\nReal curated conclusion.', 'global')).toBe(false)
    expect(isContentFree('real content', 'session')).toBe(false)
  })

  it('applies decay with disabled settings and negative age floor', () => {
    const chunk = {
      id: 'c' as never,
      path: MemoryPath('session', 'sessions', '2026-08-16-demo-a1b2c3d4.md'),
      startLine: 0,
      endLine: 1,
      text: 'x',
      source: 'session' as const,
      accessCount: 0,
      createdAt: Date.now() + 10_000,
    }
    const disabled = { enabled: false, halfLifeDays: 30 }
    expect(applyTemporalDecay(1, chunk, Date.now(), disabled)).toBe(1)
    expect(applyTemporalDecay(1, chunk, Date.now(), { enabled: true, halfLifeDays: 30 })).toBeCloseTo(1)
  })

  it('clamps source-boosted scores and reaches the access boost cap', () => {
    expect(applySourceAndAccess(0.9, 'global', 0, { global: 1, workspace: 1, session: 1 })).toBeCloseTo(0.9)
    expect(applySourceAndAccess(0.9, 'session', 1000, { global: 1, workspace: 1, session: 1 })).toBe(1)
  })

  it('reports evergreen scope membership', () => {
    expect(isEvergreenScope('global')).toBe(true)
    expect(isEvergreenScope('workspace')).toBe(true)
    expect(isEvergreenScope('session')).toBe(false)
  })
})
