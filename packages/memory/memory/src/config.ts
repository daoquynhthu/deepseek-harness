/**
 * Memory service configuration and validation.
 *
 * @module @deepseek-ai/dsh-memory
 */

import type { MemorySearchConfig, MemoryScope, TemporalDecayConfig } from './types.ts'

/** Default maximum results returned by one search. */
export const MEMORY_DEFAULT_MAX_RESULTS = 10
/** Default minimum accepted score. */
export const MEMORY_DEFAULT_MIN_SCORE = 0.1
/** Default temporal decay half-life in days. */
export const MEMORY_DEFAULT_HALF_LIFE_DAYS = 30

/** Closed set of memory scopes for configuration validation. */
const MEMORY_SCOPES: readonly MemoryScope[] = ['global', 'workspace', 'session']

/** Base configuration accepted by the memory service. */
export interface Config {
  /** Maximum results returned by one search. Defaults to 10. */
  maxResults?: number
  /** Minimum accepted score; lower-scoring chunks are dropped. Defaults to 0.1. */
  minScore?: number
  /** Apply exponential decay to session chunks when enabled. Defaults to true. */
  temporalDecayEnabled?: boolean
  /** Decay half-life in days. Defaults to 30. */
  halfLifeDays?: number
  /** Per-scope score weights. */
  sourceWeights?: Partial<Record<MemoryScope, number>>
}

/** Memory service error codes. */
export type MemoryErrorCode =
  | 'MEMORY_INVALID_CONFIG'
  | 'MEMORY_FILE_NOT_FOUND'
  | 'MEMORY_INVALID_PATH'
  | 'MEMORY_ABORTED'

/** Typed memory service error. */
export class MemoryError extends Error {
  /** Stable machine-routable error code. */
  readonly code: MemoryErrorCode

  constructor(message: string, code: MemoryErrorCode, options?: ErrorOptions) {
    super(message, options)
    this.name = 'MemoryError'
    this.code = code
  }
}

/** Memory service configuration validated at the service boundary. */
export class MemoryServiceConfig {
  /** Validated search pipeline configuration. */
  readonly search: MemorySearchConfig
  /** Per-scope score weights. */
  readonly sourceWeights: Readonly<Record<MemoryScope, number>>

  constructor(config: Config = {}) {
    const sourceWeights = resolveSourceWeights(config.sourceWeights)
    this.sourceWeights = sourceWeights
    const maxResults = config.maxResults ?? MEMORY_DEFAULT_MAX_RESULTS
    if (!Number.isSafeInteger(maxResults) || maxResults < 1) {
      throw new MemoryError(
        'memory: maxResults must be a positive safe integer',
        'MEMORY_INVALID_CONFIG',
      )
    }
    const minScore = config.minScore ?? MEMORY_DEFAULT_MIN_SCORE
    if (!Number.isFinite(minScore) || minScore < 0 || minScore > 1) {
      throw new MemoryError(
        'memory: minScore must be a number between 0 and 1',
        'MEMORY_INVALID_CONFIG',
      )
    }
    const halfLifeDays = config.halfLifeDays ?? MEMORY_DEFAULT_HALF_LIFE_DAYS
    if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) {
      throw new MemoryError(
        'memory: halfLifeDays must be a positive finite number',
        'MEMORY_INVALID_CONFIG',
      )
    }
    this.search = Object.freeze({
      maxResults,
      minScore,
      temporalDecay: Object.freeze({
        enabled: config.temporalDecayEnabled ?? true,
        halfLifeDays,
      }) satisfies TemporalDecayConfig,
      sourceWeights,
    })
  }
}

function resolveSourceWeights(
  provided: Partial<Record<MemoryScope, number>> | undefined,
): Readonly<Record<MemoryScope, number>> {
  const result: Record<MemoryScope, number> = { global: 1, workspace: 1, session: 1 }
  if (provided === undefined) return Object.freeze(result)
  for (const scope of MEMORY_SCOPES) {
    const value = provided[scope]
    if (value === undefined) continue
    if (!Number.isFinite(value) || value < 0) {
      throw new MemoryError(
        `memory: source weight for "${scope}" must be a non-negative finite number`,
        'MEMORY_INVALID_CONFIG',
      )
    }
    result[scope] = value
  }
  return Object.freeze(result)
}

/** Abort-aware search helper rejecting with a typed memory error.
 * @param signal - optional abort signal to check.
 */
export function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new MemoryError('memory search aborted', 'MEMORY_ABORTED')
}
