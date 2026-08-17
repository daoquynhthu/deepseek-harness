import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as MemoryInvariant from '../src/invariant.ts'

describe('memory invariant companion', () => {
  it('registers without throwing on an empty context', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await expect(ctx.plugin(MemoryInvariant)).resolves.toBeDefined()
  })

  it('reserves the package name against duplicate registration', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(MemoryInvariant)

    expect(() => {
      ctx.invariants.register('@deepseek-ai/dsh-memory', () => {})
    }).toThrow(/already registered/)
  })
})
