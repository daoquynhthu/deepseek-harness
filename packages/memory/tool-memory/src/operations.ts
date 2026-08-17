/**
 * Tool operations: execute memory search, read, and write against `ctx.memory`.
 *
 * @module @deepseek-ai/dsh-tool-memory/operations
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'
import { MemoryError } from '@deepseek-ai/dsh-memory'
import type { MemorySearchPage } from '@deepseek-ai/dsh-memory'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { normalizeLimit, parseMemoryPath, parseWritableMemoryPath, type MemorySearchArgs } from './input.ts'

/** Reject tool calls that are not bound to an agent session.
 * @param exec - the tool run context.
 * @throws {@link HarnessError} `MEMORY_TOOL_MISSING_AGENT` when no agent is bound.
 */
export function requireAgent(exec: ToolRunContext): void {
  if (exec.agent === undefined) {
    throw new HarnessError(
      'memory tools require an agent-bound caller',
      'MEMORY_TOOL_MISSING_AGENT',
    )
  }
}

/** Execute a `memory_search` tool call.
 * @param ctx - the hosting context.
 * @param args - model-supplied search arguments.
 * @param exec - the tool run context.
 * @param defaultLimit - deployment-configured result cap.
 * @returns the matched search page.
 */
export async function executeMemorySearch(
  ctx: Context,
  args: MemorySearchArgs,
  exec: ToolRunContext,
  defaultLimit: number,
): Promise<MemorySearchPage> {
  requireAgent(exec)
  try {
    const limit = normalizeLimit(args.limit) ?? defaultLimit
    return await ctx.memory.search({
      query: args.query,
      ...args.scope === undefined ? {} : { scope: args.scope },
      limit,
      signal: exec.signal,
    })
  } catch (error: unknown) {
    rethrowMemoryError(error)
  }
}

/** Execute a `memory_get` tool call, returning the file's full text.
 * @param ctx - the hosting context.
 * @param path - model-supplied memory file path.
 * @param exec - the tool run context.
 * @returns the file's full text.
 */
export async function executeMemoryGet(
  ctx: Context,
  path: string,
  exec: ToolRunContext,
): Promise<string> {
  requireAgent(exec)
  try {
    const branded = parseMemoryPath(path)
    return await ctx.memory.read(branded)
  } catch (error: unknown) {
    rethrowMemoryError(error)
  }
}

/** Execute a `memory_set` tool call, writing full content to one memory file.
 * @param ctx - the hosting context.
 * @param path - model-supplied memory file path.
 * @param content - full markdown content to write.
 * @param exec - the tool run context.
 * @returns the model-facing write acknowledgment.
 */
export async function executeMemorySet(
  ctx: Context,
  path: string,
  content: string,
  exec: ToolRunContext,
): Promise<string> {
  requireAgent(exec)
  try {
    const branded = parseWritableMemoryPath(path)
    await ctx.memory.write(branded, content)
  } catch (error: unknown) {
    rethrowMemoryError(error)
  }
  return `wrote memory to ${path}`
}

/** Rethrow a typed memory error under its own code for model-facing output.
 * @param error - the caught error.
 * @returns the formatted error text.
 */
export function memoryErrorText(error: unknown): string {
  if (error instanceof MemoryError) return `${error.code}: ${error.message}`
  return error instanceof Error ? error.message : String(error)
}

/** Surface a typed memory error under a stable machine-routable code.
 * @param error - the caught error.
 * @returns never resolves; always throws.
 * @throws the rethrown {@link HarnessError} or the original error.
 */
export function rethrowMemoryError(error: unknown): never {
  if (error instanceof MemoryError) {
    throw new HarnessError(error.message, error.code, { cause: error })
  }
  throw error
}
