import { describe, expect, it } from 'vitest'
import {
  MEMORY_DREAM_META_CONSUMED,
  MEMORY_DREAM_META_LAST_RUN,
  MEMORY_DREAM_SYSTEM_PROMPT,
  computeDreamSelection,
  dreamFinishError,
  dreamPrompt,
  renderDreamSection,
} from '../src/dream.ts'
import { openMemoryDatabase, readMeta, writeMeta } from '../src/schema.ts'

describe('computeDreamSelection', () => {
  it('skips when too few archives are un-consolidated', () => {
    const result = computeDreamSelection(['2026-08-16-a-11111111.md', '2026-08-17-b-22222222.md'], new Set([
      '2026-08-16-a-11111111.md',
      '2026-08-17-b-22222222.md',
    ]), 3, 10, 24, 1_000, undefined)
    expect(result).toEqual({ selected: [], skip: true })
  })

  it('skips when the previous pass is still inside the interval', () => {
    const result = computeDreamSelection(
      ['2026-08-16-a-11111111.md', '2026-08-17-b-22222222.md', '2026-08-18-c-33333333.md'],
      new Set(),
      3,
      10,
      24,
      100_000,
      99_999,
    )
    expect(result).toEqual({ selected: [], skip: true })
  })

  it('runs after the interval with enough fresh archives, oldest first and capped', () => {
    const result = computeDreamSelection(
      ['2026-08-18-c-33333333.md', '2026-08-16-a-11111111.md', '2026-08-17-b-22222222.md'],
      new Set(),
      1,
      2,
      24,
      200_000_000,
      100_000_000,
    )
    expect(result).toEqual({
      selected: ['2026-08-16-a-11111111.md', '2026-08-17-b-22222222.md'],
      skip: false,
    })
  })

  it('runs on the first pass with no recorded previous run', () => {
    const result = computeDreamSelection(
      ['2026-08-16-a-11111111.md', '2026-08-17-b-22222222.md', '2026-08-18-c-33333333.md'],
      new Set(),
      2,
      10,
      24,
      1_000,
      undefined,
    )
    expect(result.skip).toBe(false)
    expect(result.selected).toEqual([
      '2026-08-16-a-11111111.md',
      '2026-08-17-b-22222222.md',
      '2026-08-18-c-33333333.md',
    ])
  })
})

describe('dreamPrompt', () => {
  it('embeds existing workspace memory and the archive cards', () => {
    const { system, user } = dreamPrompt('# Workspace\n\n- pinned', ['card one', 'card two'])
    expect(system).toBe(MEMORY_DREAM_SYSTEM_PROMPT)
    expect(user).toBe(
      'Current workspace memory:\n# Workspace\n\n- pinned\n\n'
      + 'Session summary cards to consolidate:\n\ncard one\n\n---\n\ncard two',
    )
  })

  it('omits the workspace section when the file does not exist', () => {
    const { user } = dreamPrompt(undefined, ['card one'])
    expect(user).toBe('Session summary cards to consolidate:\n\ncard one')
  })
})

describe('renderDreamSection', () => {
  it('wraps output in a dated heading with a trailing newline', () => {
    expect(renderDreamSection('2026-08-18', '- fact')).toBe('## Dream consolidation — 2026-08-18\n\n- fact\n')
  })
})

describe('dreamFinishError', () => {
  it('accepts a clean stop', () => {
    expect(dreamFinishError({ kind: 'stop' })).toBeUndefined()
  })

  it('maps error and aborted finishes to coded failures', () => {
    const error = dreamFinishError({ kind: 'error', failure: { message: 'boom', code: 'NO_ADAPTER' } })
    expect(error?.message).toBe('boom')
    expect((error as Error & { code?: string }).code).toBe('NO_ADAPTER')
    expect(dreamFinishError({ kind: 'aborted', failure: { message: 'halted', code: 'ABORT' } })?.message).toBe('halted')
  })

  it('maps token and tool finishes to descriptive errors', () => {
    expect(dreamFinishError({ kind: 'max-tokens' })?.message).toContain('token cap')
    expect(dreamFinishError({ kind: 'tool-calls' })?.message).toContain('tool')
  })

  it('rejects an unknown finish kind', () => {
    expect(dreamFinishError({ kind: 'bogus' } as never)?.message).toContain('unsupported')
  })
})

describe('meta helpers', () => {
  it('reads undefined for a missing key and upserts values', async () => {
    const db = await openMemoryDatabase(':memory:', 'delete')
    try {
      expect(readMeta(db, 'k')).toBeUndefined()
      writeMeta(db, 'k', 'v1')
      expect(readMeta(db, 'k')).toBe('v1')
      writeMeta(db, 'k', 'v2')
      expect(readMeta(db, 'k')).toBe('v2')
      expect(readMeta(db, MEMORY_DREAM_META_CONSUMED)).toBeUndefined()
      expect(readMeta(db, MEMORY_DREAM_META_LAST_RUN)).toBeUndefined()
    } finally {
      db.close()
    }
  })
})
