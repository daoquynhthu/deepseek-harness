/**
 * Cross-session memory type definitions.
 *
 * @module @deepseek-ai/dsh-memory/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque identity of one indexed memory chunk. */
export type MemoryChunkId = Branded<'MemoryChunkId'>

/** Opaque identity of one memory file, branded to prevent cross-boundary confusion with plain paths. */
export type MemoryPath = Branded<'MemoryPath'>

/** Curated-memory scope; `session` chunks decay, evergreen scopes do not. */
export type MemoryScope = 'global' | 'workspace' | 'session'

/** Retrieval mode selected by the search pipeline; the shipped FTS path emits `fts-only`, and the deferred vector
 * path would emit the others. */
export type MemoryRetrievalMode = 'fts-only' | 'hybrid' | 'embedding-fallback'

/** One indexed chunk of a memory file. */
export interface MemoryChunk {
  /** Deterministic content hash, stable across reindexes of unchanged text. */
  readonly id: MemoryChunkId
  /** Owning memory file path. */
  readonly path: MemoryPath
  /** 0-based start line in the source file. */
  readonly startLine: number
  /** 0-based end line (exclusive) in the source file. */
  readonly endLine: number
  /** Chunk text including ancestor header context. */
  readonly text: string
  /** Curated scope the owning file belongs to. */
  readonly source: MemoryScope
  /** Number of times the chunk appeared in recall results. */
  readonly accessCount: number
  /** Creation epoch millisecond. */
  readonly createdAt: number
}

/** Search configuration resolved by the service. */
export interface MemorySearchConfig {
  /** Maximum results returned by one search. */
  readonly maxResults: number
  /** Minimum accepted score; lower-scoring chunks are dropped. */
  readonly minScore: number
  /** Temporal decay settings for session chunks. */
  readonly temporalDecay: TemporalDecayConfig
  /** Per-scope score weights. */
  readonly sourceWeights: Readonly<Record<MemoryScope, number>>
  /** Candidate-window multiplier applied to the result cap before content-free filtering. */
  readonly candidateMultiplier: number
}

/** Temporal decay settings applied to session chunks. */
export interface TemporalDecayConfig {
  /** Apply exponential decay to session chunks when enabled. */
  readonly enabled: boolean
  /** Decay half-life in days; `lambda = ln(2) / halfLifeDays`. */
  readonly halfLifeDays: number
}

/** One memory search result. */
export interface MemorySearchResult {
  readonly chunk: MemoryChunk
  /** Merged score clamped to `[0, 1]`. */
  readonly score: number
  /** Rendering-friendly snippet with match highlighting stripped. */
  readonly snippet: string
  /** Retrieval mode actually used for this query. */
  readonly mode: MemoryRetrievalMode
}

/** Page of memory search results. */
export interface MemorySearchPage {
  readonly results: readonly MemorySearchResult[]
  /** Total content-bearing matched chunk count before the result cap. */
  readonly total: number
}

/** Search request for the memory service. */
export interface MemorySearchRequest {
  /** Free-text query; FTS-only mode extracts keywords internally. */
  readonly query: string
  /** Restrict results to one scope when provided. */
  readonly scope?: MemoryScope
  /** Result cap override; defaults to the service configuration. */
  readonly limit?: number
  /** Score floor override; defaults to the service configuration. */
  readonly minScore?: number
  /** Optional cancellation. */
  readonly signal?: AbortSignal
}

/** Request for session-start memory injection. */
export interface MemoryInjectRequest {
  /** Maximum evergreen chunks to return. */
  readonly maxChunks: number
  /** Optional cancellation. */
  readonly signal?: AbortSignal
}

/** A memory file surfaced by listing. */
export interface MemoryFile {
  readonly path: MemoryPath
  readonly scope: MemoryScope
  /** Byte length of the current file content. */
  readonly sizeBytes: number
  /** Last write epoch millisecond. */
  readonly modifiedAt: number
}
