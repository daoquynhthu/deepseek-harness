import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { CallId, type UserMessage } from '@deepseek-ai/dsh-llm'
import {
  MemoryService,
  MemoryError,
  MemoryPath,
  type MemoryChunk,
  type MemoryFile,
  type MemorySearchPage,
  type MemorySearchRequest,
  type MemorySearchResult,
  type MemoryScope,
} from '@deepseek-ai/dsh-memory'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { normalizeLimit, parseMemoryPath } from '../src/input.ts'
import { memoryErrorText, rethrowMemoryError } from '../src/operations.ts'
import { presentSearchCall, renderSearchPage } from '../src/presentation.ts'
import * as ToolMemory from '../src/index.ts'

const activeContexts: Context[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of activeContexts.splice(0)) await ctx.fiber.dispose()
  FakeMemory.reset()
})

class FakeMemory extends MemoryService {
  static files = new Map<string, { content: string; scope: MemoryScope }>()
  static searchImpl: (query: string, scope?: MemoryScope) => Promise<readonly MemoryChunk[]> = () => Promise.resolve([])

  static reset(): void {
    FakeMemory.files.clear()
    FakeMemory.searchImpl = () => Promise.resolve([])
  }

  override async search(request: MemorySearchRequest): Promise<MemorySearchPage> {
    const chunks = await FakeMemory.searchImpl(request.query, request.scope)
    const results: MemorySearchResult[] = chunks.map(chunk => ({
      chunk,
      score: 1,
      snippet: chunk.text,
      mode: 'fts-only',
    }))
    return { results: results.slice(0, request.limit), total: results.length }
  }

  override async read(path: MemoryPath): Promise<string> {
    const state = FakeMemory.files.get(path)
    if (state === undefined) throw new MemoryError(`memory file not found: ${path}`, 'MEMORY_FILE_NOT_FOUND')
    return state.content
  }

  override async write(path: MemoryPath, content: string): Promise<void> {
    const scope = path.startsWith('workspace/') ? 'workspace' : path.startsWith('sessions/') ? 'session' : 'global'
    FakeMemory.files.set(path, { content, scope })
  }

  override async list(): Promise<readonly MemoryFile[]> {
    return [...FakeMemory.files.entries()].map(([path, state]) => ({
      path: path as MemoryPath,
      scope: state.scope,
      sizeBytes: Buffer.byteLength(state.content),
      modifiedAt: 0,
    }))
  }

  override async readChunks(_path: MemoryPath): Promise<readonly MemoryChunk[]> {
    return []
  }

  override async inject(_request: { maxChunks: number; signal?: AbortSignal }): Promise<readonly MemoryChunk[]> {
    return FakeMemory.searchImpl('', undefined)
  }
}

interface Mounted {
  readonly ctx: Context
  readonly fiber: Fiber
  readonly caller: Agent
  call(name: string, args: unknown, options?: {
    agent?: Agent | null | undefined
    signal?: AbortSignal | undefined
  }): Promise<ToolExecutionResult>
  preStep(payload?: Partial<{ messages: UserMessage[]; turn: number; step: number; signal: AbortSignal }>): Promise<unknown>
}

async function mount(config: ToolMemory.Config = {}): Promise<Mounted> {
  const ctx = new Context()
  activeContexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(FakeMemory)
  const fiber = await ctx.plugin(ToolMemory, config)
  const caller = fakeAgent()
  let calls = 0
  return {
    ctx,
    fiber,
    caller,
    call: (toolName, args, options = {}) => ctx.tools.execute({
      name: toolName,
      arguments: args,
      callId: CallId(`call-${++calls}`),
      signal: options.signal ?? new AbortController().signal,
      ...options.agent === null ? {} : { agent: options.agent ?? caller },
    }),
    preStep: (payload = {}) => agentEvents(ctx, caller).waterfall(
      'agent/pre-step',
      {
        messages: payload.messages ?? [],
        turn: payload.turn ?? 1,
        step: payload.step ?? 1,
        signal: payload.signal ?? new AbortController().signal,
      },
      async () => ({ kind: 'enter' as const, messages: payload.messages ?? [] }),
    ),
  }
}

function fakeAgent(): Agent {
  return { id: 'agent-1' } as unknown as Agent
}

function text(result: ToolExecutionResult): string {
  return result.content.map(block => block.type === 'text' ? block.text : '').join('\n')
}

function errorCode(result: ToolExecutionResult): string | undefined {
  return result.isError ? result.error.info?.code : undefined
}

function chunk(text: string, source: MemoryScope, path?: MemoryPath): MemoryChunk {
  const branded = path ?? (source === 'workspace'
    ? MemoryPath('workspace', 'MEMORY.md')
    : source === 'session'
      ? MemoryPath('session', 'sessions', '2026-08-16-demo-a1b2c3d4.md')
      : MemoryPath('global', 'MEMORY.md'))
  return {
    id: 'chunk-1' as never,
    path: branded,
    startLine: 0,
    endLine: 1,
    text,
    source,
    accessCount: 0,
    createdAt: 0,
  }
}

describe('registration and schemas', () => {
  it('registers three tools, the prompt section, and presenters, then disposes them', async () => {
    const mounted = await mount({ maxSearchResults: 7, maxInjectedChunks: 3 })
    const names = mounted.ctx.tools.schemas().map(schema => schema.name)
    expect(names).toEqual(['memory_search', 'memory_get', 'memory_set'])

    expect(mounted.ctx.tools.get('memory_search')?.presentCall?.({ query: 'needle' }))
      .toEqual({ card: 'generic', title: 'Search memory', rawInput: 'query "needle" in all scopes' })
    expect(mounted.ctx.tools.get('memory_get')?.presentCall?.({ path: 'MEMORY.md' }))
      .toEqual({ card: 'generic', title: 'Read memory file', rawInput: 'MEMORY.md' })
    expect(mounted.ctx.tools.get('memory_set')?.presentCall?.({ path: 'MEMORY.md', content: '# New' }))
      .toEqual({ card: 'generic', title: 'Write memory file', rawInput: 'MEMORY.md' })

    const assembly = await mounted.ctx.systemPrompt.assemble()
    expect(assembly.sections.find(section => section.name === 'tool:memory')?.text)
      .toContain('memory_search')

    await mounted.fiber.dispose()
    expect(mounted.ctx.tools.schemas().map(schema => schema.name)).toEqual([])
    expect((await mounted.ctx.systemPrompt.assemble()).sections.map(section => section.name))
      .not.toContain('tool:memory')
  })
})

describe('tool execution', () => {
  it('searches memory with the resolved default limit', async () => {
    const mounted = await mount({ maxSearchResults: 2 })
    const called: string[] = []
    FakeMemory.searchImpl = (query, scope) => {
      called.push(`${query}|${scope ?? 'all'}`)
      return Promise.resolve([chunk('Node LTS pinned.', 'global'), chunk('API key in vault.', 'workspace')])
    }
    const result = await mounted.call('memory_search', { query: 'deployment' })
    expect(called).toEqual(['deployment|all'])
    expect(text(result)).toContain('Memory search results (2)')
    expect(text(result)).toContain('Node LTS pinned')
  })

  it('reads a memory file and writes full content', async () => {
    const mounted = await mount()
    FakeMemory.files.set('MEMORY.md', { content: '# Global\n\nDeployment on Fridays.', scope: 'global' })
    const read = await mounted.call('memory_get', { path: 'MEMORY.md' })
    expect(text(read)).toContain('Deployment on Fridays.')

    const written = await mounted.call('memory_set', { path: 'workspace/MEMORY.md', content: '# Workspace\n\nNew conclusion.' })
    expect(text(written)).toBe('wrote memory to workspace/MEMORY.md')
    expect(FakeMemory.files.get('workspace/MEMORY.md')?.content).toContain('New conclusion')
  })

  it('fails agent-less calls and propagates typed memory errors', async () => {
    const mounted = await mount()
    const noAgent = await mounted.call('memory_search', { query: 'x' }, { agent: null })
    expect(noAgent.isError).toBe(true)
    expect(errorCode(noAgent)).toBe('MEMORY_TOOL_MISSING_AGENT')

    FakeMemory.searchImpl = () => Promise.reject(new MemoryError('boom', 'MEMORY_FILE_NOT_FOUND'))
    const failed = await mounted.call('memory_search', { query: 'x' })
    expect(failed.isError).toBe(true)
    expect(errorCode(failed)).toBe('MEMORY_FILE_NOT_FOUND')
    expect(text(failed)).toBe('Error: boom')
  })

  it('rejects invalid search limits', async () => {
    const mounted = await mount()
    const result = await mounted.call('memory_search', { query: 'x', limit: 0 })
    expect(result.isError).toBe(true)
    expect(errorCode(result)).toBe('MEMORY_INVALID_CONFIG')
  })

  it('passes a scope restriction through to the search', async () => {
    const mounted = await mount()
    const scopes: Array<MemoryScope | undefined> = []
    FakeMemory.searchImpl = (_query, scope) => {
      scopes.push(scope)
      return Promise.resolve([chunk('Global convention.', 'global')])
    }
    const result = await mounted.call('memory_search', { query: 'convention', scope: 'global' })
    expect(scopes).toEqual(['global'])
    expect(result.isError).toBe(false)
  })

  it('propagates a read failure under its memory error code', async () => {
    const mounted = await mount()
    const result = await mounted.call('memory_get', { path: 'MEMORY.md' })
    expect(result.isError).toBe(true)
    expect(errorCode(result)).toBe('MEMORY_FILE_NOT_FOUND')
  })

  it('rejects a write to a disallowed path', async () => {
    const mounted = await mount()
    const result = await mounted.call('memory_set', { path: 'other.md', content: '# Nope' })
    expect(result.isError).toBe(true)
    expect(errorCode(result)).toBe('MEMORY_INVALID_PATH')
  })
})

describe('path and limit normalization', () => {
  it('parses global, workspace, and session archive paths', () => {
    expect(parseMemoryPath('MEMORY.md')).toBe(MemoryPath('global', 'MEMORY.md'))
    expect(parseMemoryPath('workspace/MEMORY.md')).toBe(MemoryPath('workspace', 'MEMORY.md'))
    expect(parseMemoryPath('sessions/2026-08-16-demo-a1b2c3d4.md'))
      .toBe(MemoryPath('session', 'sessions', '2026-08-16-demo-a1b2c3d4.md'))
    expect(parseMemoryPath('  MEMORY.md  ', 'workspace')).toBe(MemoryPath('workspace', 'MEMORY.md'))
  })

  it('rejects disallowed and workspace-prefixed non-memory paths', () => {
    expect(() => parseMemoryPath('other.md')).toThrow(MemoryError)
    expect(() => parseMemoryPath('workspace/other.md')).toThrow(MemoryError)
    expect(() => parseMemoryPath('sessions/2026-08-16.md')).toThrow(MemoryError)
  })

  it('normalizes limits to a positive safe integer or undefined', () => {
    expect(normalizeLimit(undefined)).toBeUndefined()
    expect(normalizeLimit(3)).toBe(3)
    expect(() => normalizeLimit(0)).toThrow(MemoryError)
    expect(() => normalizeLimit(1.5)).toThrow(MemoryError)
  })
})

describe('error translation and rendering', () => {
  it('renders typed and untranslated errors for model output', () => {
    expect(memoryErrorText(new MemoryError('boom', 'MEMORY_FILE_NOT_FOUND')))
      .toBe('MEMORY_FILE_NOT_FOUND: boom')
    expect(memoryErrorText(new Error('plain failure'))).toBe('plain failure')
    expect(memoryErrorText('literal')).toBe('literal')
  })

  it('rethrows non-memory errors unchanged', () => {
    const plain = new Error('plain failure')
    expect(() => rethrowMemoryError(plain)).toThrow(plain)
    const typed = new MemoryError('boom', 'MEMORY_FILE_NOT_FOUND')
    let caught: unknown
    try {
      rethrowMemoryError(typed)
    } catch (error: unknown) {
      caught = error
    }
    expect(caught).toMatchObject({ message: 'boom', code: 'MEMORY_FILE_NOT_FOUND' })
  })

  it('renders an empty search page without headers', () => {
    expect(renderSearchPage({ results: [], total: 0 })).toBe('No memory matched the query.')
  })

  it('renders a scope-qualified search call card', () => {
    expect(presentSearchCall({ query: 'needle', scope: 'global' }).rawInput)
      .toBe('query "needle" in global')
  })

  it('renders injected chunks with a blank card when the text is whitespace-only', () => {
    expect(ToolMemory.renderInjectedChunks([{ source: 'global', path: 'MEMORY.md', text: '   \n  ' }]))
      .toBe('Project memory:\n- [1] (global, MEMORY.md) ')
  })
})

describe('session-start injection', () => {
  it('injects top evergreen chunks as a Project memory snapshot on step 1', async () => {
    const mounted = await mount({ maxInjectedChunks: 2 })
    FakeMemory.searchImpl = () => Promise.resolve([
      chunk('Global convention.', 'global'),
      chunk('Workspace secret.', 'workspace'),
    ])
    const decision = await mounted.preStep({ step: 1 })
    expect(decision).toMatchObject({ kind: 'enter' })
    const messages = (decision as { messages: UserMessage[] }).messages
    expect(messages.length).toBe(1)
    const block = messages[0]!.content[0]!
    expect(block.type).toBe('text')
    expect((block as { text: string }).text).toContain('Global convention')
    expect(messages[0]!.source).toMatchObject({ kind: 'plugin', plugin: 'tool-memory', form: 'snapshot' })
  })

  it('skips injection when no chunks, later steps, aborted, or rejected', async () => {
    const mounted = await mount()
    FakeMemory.searchImpl = () => Promise.resolve([])
    await expect(mounted.preStep({ step: 1 })).resolves.toMatchObject({ kind: 'enter', messages: [] })

    FakeMemory.searchImpl = () => Promise.resolve([chunk('Hit.', 'global')])
    const later = await mounted.preStep({ step: 2 })
    expect((later as { messages: UserMessage[] }).messages).toEqual([])

    const aborted = new AbortController()
    aborted.abort()
    const abortedStep = await mounted.preStep({ step: 1, signal: aborted.signal })
    expect((abortedStep as { messages: UserMessage[] }).messages).toEqual([])
  })

  it('degrades to the base decision when memory injection fails', async () => {
    const mounted = await mount()
    FakeMemory.searchImpl = () => Promise.reject(new MemoryError('index down', 'MEMORY_INVALID_CONFIG'))
    const decision = await mounted.preStep({ step: 1 })
    expect(decision).toMatchObject({ kind: 'enter', messages: [] })
  })
})

describe('config validation', () => {
  it('accepts defaults and rejects invalid bounds at the loader boundary', async () => {
    const mounted = await mount({})
    expect(mounted.fiber).toBeDefined()
    await mounted.fiber.dispose()

    const ctx = new Context()
    activeContexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(FakeMemory)
    await expect(ctx.plugin(ToolMemory, { maxSearchResults: 0 })).rejects.toThrow(/maxSearchResults/)
    await expect(ctx.plugin(ToolMemory, { maxInjectedChunks: 0 })).rejects.toThrow(/maxInjectedChunks/)
  })

  it('validates bounds and applies defaults for direct apply callers', async () => {
    const bare = new Context()
    expect(() =>{  ToolMemory.apply(bare, { maxSearchResults: 0 }) }).toThrow(/maxSearchResults/)
    expect(() =>{  ToolMemory.apply(bare, { maxInjectedChunks: 0 }) }).toThrow(/maxInjectedChunks/)

    const ctx = new Context()
    activeContexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(FakeMemory)
    expect(() =>{  ToolMemory.apply(ctx, {}) }).not.toThrow()
    expect(ctx.tools.schemas().map(schema => schema.name)).toEqual(['memory_search', 'memory_get', 'memory_set'])
  })
})
