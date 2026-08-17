/**
 * Service Definition for cross-session curated knowledge with keyword recall.
 *
 * @module @deepseek-ai/dsh-memory
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { MemoryServiceConfig, MemoryError, assertNotAborted, type Config } from './config.ts'
import type { MemoryChunk, MemoryFile, MemoryInjectRequest, MemoryPath, MemorySearchPage, MemorySearchRequest } from './types.ts'

export type {
  MemoryChunk,
  MemoryChunkId,
  MemoryFile,
  MemoryInjectRequest,
  MemoryRetrievalMode,
  MemoryScope,
  MemorySearchConfig,
  MemorySearchPage,
  MemorySearchRequest,
  MemorySearchResult,
  TemporalDecayConfig,
} from './types.ts'
export type { Config, MemoryErrorCode } from './config.ts'
export { MEMORY_DEFAULT_MAX_RESULTS, MEMORY_DEFAULT_MIN_SCORE, MemoryError } from './config.ts'
export { chunkHash, chunkMarkdown, attributeChunk } from './chunker.ts'
export type { ChunkConfig, ExtractedChunk } from './chunker.ts'
export {
  applySourceAndAccess,
  applyTemporalDecay,
  isContentFree,
  isEvergreenScope,
} from './scoring.ts'
export {
  MemoryPath,
  isSessionArchivePath,
  isWorkspaceMemoryPath,
  scopeOfPath,
  type MemoryPath as MemoryPathFactory,
} from './path.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    memory: MemoryService
  }
}

/**
 * Unified cross-session memory service.
 *
 * Search, read, write, and list are backend-independent concrete contracts;
 * a backend implements storage, indexing, and retrieval on the same
 * `ctx.memory` service.
 */
export abstract class MemoryService extends Service {
  static inject = []

  /** Validated service configuration shared by every backend operation. */
  readonly config: MemoryServiceConfig

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'memory')
    this.config = new MemoryServiceConfig(config)
  }

  /**
   * Search curated memory with the FTS keyword pipeline.
   * @param request - query, optional scope/limit/min-score overrides, cancellation.
   * @returns ranked results with per-result mode and coverage metadata.
   */
  abstract search(request: MemorySearchRequest): Promise<MemorySearchPage>

  /**
   * Read the current content of one memory file.
   * @param path - branded memory file path.
   * @returns the file's full text.
   * @throws {@link MemoryError} `MEMORY_FILE_NOT_FOUND` when absent.
   */
  abstract read(path: MemoryPath): Promise<string>

  /**
   * Write one memory file, replacing existing content atomically.
   * @param path - branded memory file path.
   * @param content - new full text content.
   */
  abstract write(path: MemoryPath, content: string): Promise<void>

  /**
   * List known memory files with size and modification metadata.
   * @returns files in deterministic order.
   */
  abstract list(): Promise<readonly MemoryFile[]>

  /**
   * Return the chunks of one memory file, refreshed from durable state.
   * @param path - branded memory file path.
   * @returns current chunks in document order.
   * @throws {@link MemoryError} `MEMORY_FILE_NOT_FOUND` when absent.
   */
  abstract readChunks(path: MemoryPath): Promise<readonly MemoryChunk[]>

  /**
   * Return top evergreen chunks for session-start injection.
   * @param request - maximum chunk count and optional cancellation.
   * @returns evergreen chunks ranked for injection, content-free chunks excluded.
   */
  abstract inject(request: MemoryInjectRequest): Promise<readonly MemoryChunk[]>
}

/**
 * Validate a search request's optional bounds against the service config.
 * @param service - the memory service owning the resolved configuration.
 * @param request - the search request being validated.
 * @returns the resolved result cap and score floor.
 */
export function resolveSearchLimits(
  service: MemoryService,
  request: MemorySearchRequest,
): { limit: number; minScore: number } {
  const limit = request.limit ?? service.config.search.maxResults
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new MemoryError('memory: limit must be a positive safe integer', 'MEMORY_INVALID_CONFIG')
  }
  const minScore = request.minScore ?? service.config.search.minScore
  if (!Number.isFinite(minScore) || minScore < 0 || minScore > 1) {
    throw new MemoryError(
      'memory: minScore must be a number between 0 and 1',
      'MEMORY_INVALID_CONFIG',
    )
  }
  assertNotAborted(request.signal)
  return { limit, minScore }
}

export { assertNotAborted }

export default MemoryService
