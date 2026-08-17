import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as MemoryMarkdownInvariant from '../src/invariant.ts'

describe('memory-markdown invariant companion', () => {
  it('registers without throwing on an empty context', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await expect(ctx.plugin(MemoryMarkdownInvariant)).resolves.toBeDefined()
  })

  it('reserves the package name against duplicate registration', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(MemoryMarkdownInvariant)

    expect(() => {
      ctx.invariants.register('@deepseek-ai/dsh-memory-markdown', () => {})
    }).toThrow(/already registered/)
  })
})
