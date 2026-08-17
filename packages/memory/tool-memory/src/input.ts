/**
 * Model argument schemas for the memory tools.
 *
 * @module @deepseek-ai/dsh-tool-memory/input
 */

import { MemoryError, MemoryPath, type MemoryPath as MemoryPathValue, type MemoryScope } from '@deepseek-ai/dsh-memory'

const memorySearchParameters = {
  query: { type: 'string', required: true, description: 'Free-text query over curated memory chunks.' },
  scope: {
    type: 'string',
    enum: ['global', 'workspace', 'session'],
    description: 'Restrict results to one memory scope. Omit to search all scopes.',
  },
  limit: { type: 'integer', description: 'Maximum results. Defaults to the deployment configuration.' },
} as const

const memoryGetParameters = {
  path: {
    type: 'string',
    required: true,
    description: 'Memory file path, for example MEMORY.md or sessions/2026-08-16-summary-a1b2c3d4.md.',
  },
} as const

const memorySetParameters = {
  path: {
    type: 'string',
    required: true,
    description: 'Memory file path: MEMORY.md (global) or workspace/MEMORY.md (workspace).',
  },
  content: { type: 'string', required: true, description: 'Full markdown content to write, replacing existing content.' },
} as const

/** Parse a model-supplied memory path string into a branded path.
 * @param path - model-supplied path string.
 * @param scope - default scope for bare `MEMORY.md`.
 * @returns the branded memory path.
 * @throws {@link MemoryError} `MEMORY_INVALID_PATH` when the path is not allowed.
 */
export function parseMemoryPath(path: string, scope: MemoryScope = 'global'): MemoryPathValue {
  const trimmed = path.trim()
  if (trimmed === 'MEMORY.md') return MemoryPath(scope, 'MEMORY.md')
  if (trimmed.startsWith('workspace/') && trimmed === 'workspace/MEMORY.md') {
    return MemoryPath('workspace', 'MEMORY.md')
  }
  if (trimmed.startsWith('sessions/')) {
    const name = trimmed.slice('sessions/'.length)
    return MemoryPath('session', 'sessions', name)
  }
  throw new MemoryError(
    `memory: "${path}" is not an allowed memory path`,
    'MEMORY_INVALID_PATH',
  )
}

/** Model arguments for a `memory_search` tool call. */
export interface MemorySearchArgs {
  readonly query: string
  readonly scope?: MemoryScope
  readonly limit?: number
}

/** Parse a model-supplied writable memory path, rejecting session archives.
 * @param path - model-supplied path string.
 * @returns the branded writable memory path.
 * @throws {@link MemoryError} `MEMORY_INVALID_PATH` when the path is not writable.
 */
export function parseWritableMemoryPath(path: string): MemoryPathValue {
  const trimmed = path.trim()
  if (trimmed === 'MEMORY.md') return MemoryPath('global', 'MEMORY.md')
  if (trimmed === 'workspace/MEMORY.md') return MemoryPath('workspace', 'MEMORY.md')
  throw new MemoryError(
    `memory: "${path}" is not a writable memory path`,
    'MEMORY_INVALID_PATH',
  )
}

/** Normalize a search limit argument to a safe positive integer or undefined.
 * @param limit - model-supplied limit argument.
 * @returns the normalized limit, or `undefined` when omitted.
 * @throws {@link MemoryError} `MEMORY_INVALID_CONFIG` when the limit is not a positive safe integer.
 */
export function normalizeLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) return undefined
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new MemoryError('memory: limit must be a positive safe integer', 'MEMORY_INVALID_CONFIG')
  }
  return limit
}

/** Model schemas and model-owned value normalization shared by tool operations. */
export const toolInput = {
  memorySearchParameters,
  memoryGetParameters,
  memorySetParameters,
  parseMemoryPath,
  parseWritableMemoryPath,
  normalizeLimit,
}
