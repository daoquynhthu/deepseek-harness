/**
 * FTS5 query construction, keyword extraction, and score application.
 *
 * @module @deepseek-ai/dsh-memory-markdown
 */

import type { DatabaseSync } from 'node:sqlite'
import {
  applySourceAndAccess,
  applyTemporalDecay,
  isContentFree,
  type MemoryChunk,
  type MemoryChunkId,
  type MemoryPath,
  type MemoryScope,
  type MemorySearchConfig,
} from '@deepseek-ai/dsh-memory'

/** English stop words removed during FTS-only keyword extraction. */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'this', 'that', 'these', 'those',
  'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'she', 'it', 'they', 'him',
  'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'and', 'or', 'but', 'if', 'then', 'else', 'of', 'on', 'in', 'at', 'to', 'for',
  'with', 'by', 'from', 'as', 'about', 'into', 'over', 'after', 'before',
  'what', 'when', 'where', 'which', 'who', 'whom', 'why', 'how',
  'do', 'does', 'did', 'have', 'has', 'had', 'will', 'would', 'can', 'could',
])

/** Extract FTS keywords from a conversational query by removing stop words.
 * @param query - free-text query.
 * @returns deduplicated lowercase keyword terms.
 */
export function extractKeywords(query: string): string[] {
  const lowered = query.toLowerCase()
  const tokens = lowered.split(/[^a-z0-9]+/).filter(token => token.length > 0)
  const seen = new Set<string>()
  const result: string[] = []
  for (const token of tokens) {
    if (STOP_WORDS.has(token) || seen.has(token)) continue
    seen.add(token)
    result.push(token)
  }
  return result
}

/** Quote a keyword so FTS5 treats it as a literal term. */
function quoteTerm(term: string): string {
  return `"${term.replaceAll('"', '""')}"`
}

/** One row read from the FTS index. */
export interface IndexedChunkRow {
  readonly id: string
  readonly path: string
  readonly start_line: number
  readonly end_line: number
  readonly text: string
  readonly source: MemoryScope
  readonly access_count: number
  readonly created_at: number
}

/** Result of one keyword scan. */
export interface KeywordScan {
  readonly rows: readonly IndexedChunkRow[]
  /** Total matched chunk count before the result cap. */
  readonly total: number
  readonly matches: readonly string[]
}

/**
 * Run an FTS5 keyword scan over the chunk index.
 *
 * FTS-only mode calls this directly with the extracted keywords; a deferred
 * vector path would merge its results with these rows. When no keywords survive stop-word
 * filtering, the scan matches nothing and returns an empty result.
 * @param db - open memory index handle.
 * @param keywords - extracted query keywords.
 * @param scope - optional scope restriction.
 * @param limit - maximum result rows to return.
 * @returns matched rows with the exact keyword terms used.
 */
export function keywordScan(
  db: DatabaseSync,
  keywords: readonly string[],
  scope: MemoryScope | undefined,
  limit: number,
): KeywordScan {
  if (keywords.length === 0) return { rows: [], total: 0, matches: [] }
  const where: string[] = []
  const params: Array<string | number> = []
  for (const keyword of keywords) {
    where.push('chunks_fts MATCH ?')
    params.push(quoteTerm(keyword))
  }
  if (scope !== undefined) {
    where.push('c.source = ?')
    params.push(scope)
  }
  const whereSql = where.join(' AND ')
  const rows = db.prepare(`
    SELECT c.id, c.path, c.start_line, c.end_line, c.text, c.source, c.access_count, c.created_at
    FROM chunks_fts
    JOIN chunks AS c ON c.id = chunks_fts.id
    WHERE ${whereSql}
    ORDER BY rank
    LIMIT ?
  `).all(...params, limit) as unknown as IndexedChunkRow[]
  const total = (db.prepare(`
    SELECT COUNT(*) AS count
    FROM chunks_fts
    JOIN chunks AS c ON c.id = chunks_fts.id
    WHERE ${whereSql}
  `).get(...params) as { count: number }).count
  return {
    rows,
    total,
    matches: keywords,
  }
}

/** Compute the final score for one indexed row.
 * @param row - indexed chunk row.
 * @param base - normalized base score in `[0, 1]`.
 * @param now - current epoch millisecond.
 * @param config - search configuration.
 * @param sourceWeights - per-scope score weights.
 * @returns the final score clamped to `[0, 1]`.
 */
export function scoreRow(
  row: IndexedChunkRow,
  base: number,
  now: number,
  config: MemorySearchConfig,
  sourceWeights: Readonly<Record<MemoryScope, number>>,
): number {
  const chunk = rowToChunk(row)
  const decayed = applyTemporalDecay(base, chunk, now, config.temporalDecay)
  return applySourceAndAccess(decayed, chunk.source, chunk.accessCount, sourceWeights)
}

/** Convert an indexed row into a domain chunk record.
 * @param row - indexed chunk row.
 * @returns the domain chunk record.
 */
export function rowToChunk(row: IndexedChunkRow): MemoryChunk {
  return {
    id: row.id as MemoryChunkId,
    path: row.path as MemoryPath,
    startLine: row.start_line,
    endLine: row.end_line,
    text: row.text,
    source: row.source,
    accessCount: row.access_count,
    createdAt: row.created_at,
  }
}

/** Render a snippet from a chunk's first substantive line.
 * @param text - full chunk text.
 * @returns a bounded snippet without header lines.
 */
export function makeSnippet(text: string): string {
  const lines = text.split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'))
  return (lines[0] ?? text).slice(0, 240)
}

/** Filter content-free chunks out of a scored candidate list.
 * @param candidates - scored chunk candidates.
 * @returns the chunks that are not content-free.
 */
export function filterContentFree(
  candidates: readonly MemoryChunk[],
): readonly MemoryChunk[] {
  return candidates.filter(chunk => !isContentFree(chunk.text, chunk.source))
}
