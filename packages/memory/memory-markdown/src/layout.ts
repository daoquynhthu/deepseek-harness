/**
 * Markdown memory storage layout: scope roots, workspace hash, and file I/O.
 *
 * The root resolves through the harness home; workspace-scoped files live
 * under a blake3-derived directory so two checkouts of one project share one
 * memory without storing plaintext workspace paths.
 *
 * @module @deepseek-ai/dsh-memory-markdown
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { MemoryError, MemoryPath, isSessionArchivePath, isWorkspaceMemoryPath, type MemoryScope } from '@deepseek-ai/dsh-memory'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Directory name for the memory root under the harness home. */
export const MEMORY_ROOT_DIR = 'memory'

/** Default maximum chunk size in characters. */
export const MEMORY_DEFAULT_MAX_CHUNK_CHARS = 800
/** Default overlap in characters between continuation chunks. */
export const MEMORY_DEFAULT_CHUNK_OVERLAP_CHARS = 120

/** Absolute memory layout for one provider instance. */
export interface MemoryLayout {
  readonly root: string
  readonly globalDir: string
  readonly workspaceDir: string
  readonly globalMemoryFile: string
  readonly workspaceMemoryFile: string
  readonly sessionsDir: string
}

/**
 * Resolve the memory storage layout.
 * @param workspace - caller workspace path used to derive the workspace directory.
 * @param rootOverride - explicit memory root override; defaults to `{dshHome}/memory`.
 * @param dshHome - explicit harness home used when `rootOverride` is absent.
 * @returns the resolved absolute layout.
 */
export function resolveMemoryLayout(
  workspace: string,
  rootOverride: string | undefined,
  dshHome: string | undefined,
): MemoryLayout {
  const root = rootOverride === undefined
    ? join(resolveDshHome(dshHome), MEMORY_ROOT_DIR)
    : resolve(rootOverride)
  const workspaceHash = workspaceHashOf(workspace)
  const workspaceDir = join(root, workspaceHash)
  return {
    root,
    globalDir: root,
    workspaceDir,
    globalMemoryFile: join(root, 'MEMORY.md'),
    workspaceMemoryFile: join(workspaceDir, 'MEMORY.md'),
    sessionsDir: join(workspaceDir, 'sessions'),
  }
}

/** Compute the stable truncated workspace directory hash.
 * @param workspace - caller workspace path to hash.
 * @returns the 16-hex-character directory name.
 */
export function workspaceHashOf(workspace: string): string {
  return createHash('blake2b512')
    .update(resolve(workspace), 'utf8')
    .digest('hex')
    .slice(0, 16)
}

/** Resolve a branded memory path to its absolute filesystem path.
 * @param layout - resolved memory layout.
 * @param path - branded memory file path.
 * @returns the absolute filesystem path.
 */
export function absolutePath(layout: MemoryLayout, path: ReturnType<typeof MemoryPath>): string {
  if (isSessionArchivePath(path)) return join(layout.sessionsDir, path.slice('sessions/'.length))
  if (isWorkspaceMemoryPath(path)) return join(layout.workspaceDir, path.slice('workspace/'.length))
  return join(layout.globalDir, path)
}

/** Resolve the scope of a path against the layout.
 * @param path - branded memory file path.
 * @returns the path's owning scope.
 */
export function pathScope(path: ReturnType<typeof MemoryPath>): MemoryScope {
  if (isSessionArchivePath(path)) return 'session'
  if (isWorkspaceMemoryPath(path)) return 'workspace'
  return 'global'
}

/** Ensure all layout directories exist.
 * @param layout - resolved memory layout whose directories to create.
 */
export async function ensureMemoryDirectories(layout: MemoryLayout): Promise<void> {
  await mkdir(layout.workspaceDir, { recursive: true, mode: 0o700 })
  await mkdir(layout.sessionsDir, { recursive: true, mode: 0o700 })
}

/** Read a file's UTF-8 text; absent files report the typed not-found error.
 * @param path - absolute filesystem path.
 * @returns the file's full text.
 * @throws {@link MemoryError} `MEMORY_FILE_NOT_FOUND` when the file is absent.
 */
export async function readMemoryFile(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new MemoryError('memory file not found', 'MEMORY_FILE_NOT_FOUND', { cause: error })
    }
    throw error
  }
}

/** Atomically replace a file's content, creating missing parents.
 * @param path - absolute filesystem path.
 * @param content - new UTF-8 text content.
 */
export async function writeMemoryFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, content, 'utf8')
  await rename(temporary, path)
}
