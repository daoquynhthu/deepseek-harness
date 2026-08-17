import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as ToolMemoryInvariant from '../src/invariant.ts'

describe('tool-memory invariant companion', () => {
  it('registers without throwing on an empty context', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await expect(ctx.plugin(ToolMemoryInvariant)).resolves.toBeDefined()
  })

  it('reserves the package name against duplicate registration', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(ToolMemoryInvariant)

    expect(() => {
      ctx.invariants.register('@deepseek-ai/dsh-tool-memory', () => {})
    }).toThrow(/already registered/)
  })
})
