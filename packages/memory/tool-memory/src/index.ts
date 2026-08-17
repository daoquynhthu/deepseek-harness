/**
 * Model-facing cross-session memory tools and session-start injection.
 *
 * Registers `memory_search`, `memory_get`, and `memory_set` on `ctx.tools`,
 * contributes a static prompt section naming the read tools, and injects up
 * to `maxInjectedChunks` top evergreen chunks into each session start as a
 * "Project memory" snapshot.
 *
 * @module @deepseek-ai/dsh-tool-memory
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { toolInput } from './input.ts'
import {
  executeMemoryGet,
  executeMemorySearch,
  executeMemorySet,
  memoryErrorText,
} from './operations.ts'
import {
  presentGetCall,
  presentSearchCall,
  presentSetCall,
  renderSearchPage,
} from './presentation.ts'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'tool-memory'

/** Capability services required by the model-facing consumer. */
export const inject = ['tools', 'systemPrompt', 'memory']

/** Default maximum search hits returned by one `memory_search` call. */
export const DEFAULT_MAX_SEARCH_RESULTS = 10

/** Default number of evergreen chunks injected at session start. */
export const DEFAULT_MAX_INJECTED_CHUNKS = 5

/** Deployment-owned memory tool bounds. */
export interface Config {
  /** Maximum hits returned by one `memory_search` call. Defaults to 10. */
  maxSearchResults?: number
  /** Number of top evergreen chunks injected at session start. Defaults to 5. */
  maxInjectedChunks?: number
}

/** Schemastery config for Loader defaults and generated configuration docs. */
export const Config: z<Config> = z.object({
  maxSearchResults: z.number().step(1).min(1).default(DEFAULT_MAX_SEARCH_RESULTS),
  maxInjectedChunks: z.number().step(1).min(1).default(DEFAULT_MAX_INJECTED_CHUNKS),
})

interface ResolvedConfig {
  readonly maxSearchResults: number
  readonly maxInjectedChunks: number
}

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

const PROMPT_TEXT =
  'Curated project knowledge persists across sessions in memory. Use memory_search to find durable '
  + 'conclusions and conventions from prior sessions, and memory_get to read the full memory file behind a '
  + 'hit. Use memory_set to write durable conclusions worth remembering.'

/** Register the memory tools, prompt section, and session-start injection. */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  ctx.systemPrompt.section({
    name: 'tool:memory',
    order: 114,
    text: PROMPT_TEXT,
  })

  ctx.tools.register(defineTool({
    name: 'memory_search',
    description: 'Search curated cross-session memory and return the strongest matching knowledge chunks.',
    parameters: toolInput.memorySearchParameters,
    output: TEXT_OUTPUT,
    execute: async (args, exec) => renderSearchPage(await executeMemorySearch(ctx, args, exec, resolved.maxSearchResults)),
    presentCall: args => presentSearchCall(args),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_get',
    description: 'Read one memory file completely, for example MEMORY.md or a specific session archive.',
    parameters: toolInput.memoryGetParameters,
    output: TEXT_OUTPUT,
    execute: (args, exec) => executeMemoryGet(ctx, args.path, exec),
    presentCall: args => presentGetCall(args),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_set',
    description: 'Write one memory file with full markdown content, replacing any existing content.',
    parameters: toolInput.memorySetParameters,
    output: TEXT_OUTPUT,
    execute: (args, exec) => executeMemorySet(ctx, args.path, args.content, exec),
    presentCall: args => presentSetCall(args),
  }))

  ctx.on('agent/pre-step', async (
    { step, signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || step !== 1 || signal.aborted) return decision
    let chunks
    try {
      chunks = await ctx.memory.inject({ maxChunks: resolved.maxInjectedChunks, signal })
    } catch (error: unknown) {
      ctx.logger.warn('memory injection failed: %s', memoryErrorText(error))
      return decision
    }
    if (chunks.length === 0) return decision
    const text = renderInjectedChunks(chunks)
    return {
      kind: 'enter',
      messages: [
        ...decision.messages,
        createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'plugin', plugin: name, form: 'snapshot', sections: [{ name: 'Project memory', text }] },
        }),
      ],
    }
  })
}

/** Render injected evergreen chunks as compact knowledge cards.
 * @param chunks - evergreen chunks selected for session-start injection.
 * @returns the rendered card list.
 */
export function renderInjectedChunks(chunks: readonly { source: string; path: string; text: string }[]): string {
  const lines = ['Project memory:']
  for (const [index, chunk] of chunks.entries()) {
    lines.push(`- [${index + 1}] (${chunk.source}, ${chunk.path}) ${firstLine(chunk.text)}`)
  }
  return lines.join('\n')
}

function firstLine(text: string): string {
  const line = text.split('\n').map(entry => entry.trim()).find(entry => entry.length > 0) ?? ''
  return line.slice(0, 200)
}

function resolveConfig(config: Config): ResolvedConfig {
  const maxSearchResults = config.maxSearchResults ?? DEFAULT_MAX_SEARCH_RESULTS
  const maxInjectedChunks = config.maxInjectedChunks ?? DEFAULT_MAX_INJECTED_CHUNKS
  if (!Number.isSafeInteger(maxSearchResults) || maxSearchResults < 1) {
    throw new TypeError('tool-memory: maxSearchResults must be a positive safe integer')
  }
  if (!Number.isSafeInteger(maxInjectedChunks) || maxInjectedChunks < 1) {
    throw new TypeError('tool-memory: maxInjectedChunks must be a positive safe integer')
  }
  return { maxSearchResults, maxInjectedChunks }
}
