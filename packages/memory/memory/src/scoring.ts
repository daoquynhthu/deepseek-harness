/**
 * Hybrid search scoring: temporal decay, source weights, access boost, and
 * content-free chunk filtering.
 *
 * @module @deepseek-ai/dsh-memory
 */

import type { MemoryChunk, MemoryScope, TemporalDecayConfig } from './types.ts'

/** Sources that hold curated long-term knowledge and are exempt from decay. */
const EVERGREEN_SCOPES = new Set<MemoryScope>(['global', 'workspace'])

/** Return `true` when a scope holds evergreen (non-decaying) curated knowledge.
 * @param scope - the memory scope to classify.
 * @returns `true` for `global` and `workspace`.
 */
export function isEvergreenScope(scope: MemoryScope): boolean {
  return EVERGREEN_SCOPES.has(scope)
}

/**
 * Apply exponential temporal decay to a chunk's base score.
 *
 * Only session chunks decay; evergreen sources keep their base score. The
 * half-life setting controls how quickly session knowledge ages.
 * @param base - normalized base score in `[0, 1]`.
 * @param chunk - the chunk being scored.
 * @param now - current epoch millisecond.
 * @param decay - temporal decay settings.
 * @returns the decayed score, or the base score for evergreen scopes.
 */
export function applyTemporalDecay(
  base: number,
  chunk: MemoryChunk,
  now: number,
  decay: TemporalDecayConfig,
): number {
  if (!decay.enabled || isEvergreenScope(chunk.source)) return base
  const ageDays = Math.max(0, (now - chunk.createdAt) / 86_400_000)
  return base * Math.exp((-Math.LN2 / decay.halfLifeDays) * ageDays)
}

/**
 * Return `true` when a chunk is structurally empty or boilerplate scaffolding
 * that must never surface in results or injection.
 * @param text - the chunk text.
 * @param source - the chunk's owning scope.
 * @returns `true` for content-free chunks.
 */
export function isContentFree(text: string, source: MemoryScope): boolean {
  return isStructurallyEmpty(text)
    || (isEvergreenScope(source) && isScaffoldTemplate(text))
}

/** Return `true` when text has no substantive content after stripping headings and comments. */
function isStructurallyEmpty(text: string): boolean {
  const withoutComments = stripHtmlComments(text)
  for (const line of withoutComments.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    if (trimmed.startsWith('#')) continue
    return false
  }
  return true
}

/** Strip HTML comments (`<!-- ... -->`), which may span lines. */
function stripHtmlComments(text: string): string {
  let result = ''
  let rest = text
  while (true) {
    const start = rest.indexOf('<!--')
    if (start < 0) {
      result += rest
      return result
    }
    result += rest.slice(0, start)
    const after = rest.indexOf('-->', start + '<!--'.length)
    if (after < 0) return result
    rest = rest.slice(after + '-->'.length)
  }
}

/** Scaffold template markers used by evergreen `MEMORY.md` stubs. */
const SCAFFOLD_MARKERS = [
  'this file is managed',
  'auto-generated',
  'do not edit',
  'curated knowledge',
]

/** Return `true` when an evergreen chunk looks like an empty scaffold template. */
function isScaffoldTemplate(text: string): boolean {
  const lower = text.toLowerCase()
  const nonHeaderLines = lower.split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'))
  const first = nonHeaderLines[0]
  /* v8 ignore next -- isContentFree short-circuits on structurally empty text, so a non-empty caller always has lines */
  if (first === undefined) return true
  return SCAFFOLD_MARKERS.some(marker => first.includes(marker))
}

/**
 * Merge base scores with scope weights and an access-frequency boost.
 * @param base - the already decayed base score.
 * @param source - chunk scope.
 * @param accessCount - how often the chunk appeared in recall.
 * @param sourceWeights - per-scope weights.
 * @returns the boosted score, clamped to `[0, 1]`.
 */
export function applySourceAndAccess(
  base: number,
  source: MemoryScope,
  accessCount: number,
  sourceWeights: Readonly<Record<MemoryScope, number>>,
): number {
  const weighted = base * sourceWeights[source]
  const boost = Math.min(0.2, Math.log1p(accessCount) * 0.05)
  return Math.min(1, weighted + boost)
}
