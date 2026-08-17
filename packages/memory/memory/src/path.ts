/**
 * MemoryPath factory and validation.
 *
 * The branded path string encodes its scope root: `MEMORY.md` at the global
 * root, `workspace/MEMORY.md` under the workspace hash directory, and
 * `sessions/{archive}` for session archives. Encoding the scope in the string
 * keeps the opaque identity self-describing across storage and index rows.
 *
 * @module @deepseek-ai/dsh-memory
 */

import { MemoryError } from './config.ts'
import type { MemoryPath as MemoryPathBrand } from './types.ts'

/** Opaque identity of one memory file, branded to prevent cross-boundary confusion with plain paths. */
export type MemoryPath = MemoryPathBrand

/** Session archive names are `YYYY-MM-DD-{slug}-{sid8}.md`. */
const ARCHIVE_NAME = /^\d{4}-\d{2}-\d{2}-[a-z0-9-]+-[a-z0-9]{8}\.md$/

/**
 * Construct a branded memory path from its scope and relative segments.
 *
 * Paths are constrained to the known curated files: `MEMORY.md` at the global
 * or workspace root, or a session archive under `sessions/`. Any other path
 * is rejected, keeping model write authority narrow.
 * @param scope - owning memory scope.
 * @param segments - relative path segments under the scope root.
 * @returns the branded memory path.
 * @throws {@link MemoryError} `MEMORY_INVALID_PATH` when the path is not allowed.
 */
export function MemoryPath(scope: MemoryScopeLike, ...segments: string[]): MemoryPath {
  if (segments.length === 0) {
    throw new MemoryError('memory: memory path must include at least one segment', 'MEMORY_INVALID_PATH')
  }
  const joined = segments.join('/').replaceAll('\\', '/')
  if (scope === 'global' && segments.length === 1 && joined === 'MEMORY.md') {
    return joined as MemoryPath
  }
  if (scope === 'workspace' && segments.length === 1 && joined === 'MEMORY.md') {
    return `workspace/${joined}` as MemoryPath
  }
  if (scope === 'session' && segments.length === 2 && segments[0] === 'sessions' && ARCHIVE_NAME.test(segments[1] as string)) {
    return joined as MemoryPath
  }
  throw new MemoryError(
    `memory: "${joined}" is not an allowed memory path for scope "${scope}"`,
    'MEMORY_INVALID_PATH',
  )
}

/** Literal scope values accepted by the factory. */
export type MemoryScopeLike = 'global' | 'workspace' | 'session'

/** Return `true` when a memory path is a session archive under `sessions/`.
 * @param path - branded memory file path.
 * @returns `true` for a session archive path.
 */
export function isSessionArchivePath(path: MemoryPath): boolean {
  return path.startsWith('sessions/')
}

/** Return `true` when a memory path names the workspace `MEMORY.md`.
 * @param path - branded memory file path.
 * @returns `true` for the workspace memory file.
 */
export function isWorkspaceMemoryPath(path: MemoryPath): boolean {
  return path.startsWith('workspace/')
}

/** Render a memory path's owning scope from its leading segment.
 * @param path - branded memory file path.
 * @returns the path's owning scope.
 */
export function scopeOfPath(path: MemoryPath): MemoryScopeLike {
  if (path.startsWith('sessions/')) return 'session'
  if (path.startsWith('workspace/')) return 'workspace'
  return 'global'
}
