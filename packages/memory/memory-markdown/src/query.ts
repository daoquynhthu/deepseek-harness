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

/** English stop words removed during FTS-only keyword extraction.
 * The list follows grok's keyword side: articles, pronouns, common verbs,
 * prepositions, conjunctions, question words, vague references, time
 * references, request words, and common filler. */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'this', 'that', 'these', 'those',
  'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'she', 'it', 'they',
  'him', 'her', 'its', 'them', 'us',
  'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'can', 'may', 'might',
  'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'about',
  'into', 'through', 'during', 'before', 'after', 'above', 'below', 'over',
  'and', 'or', 'but', 'if', 'then', 'else', 'because', 'as', 'while',
  'what', 'when', 'where', 'which', 'who', 'whom', 'why', 'how',
  'thing', 'things', 'stuff', 'something', 'anything', 'everything',
  'one', 'some', 'any', 'all', 'each', 'every', 'both', 'few', 'more',
  'yesterday', 'today', 'tomorrow', 'earlier', 'later', 'recently',
  'now', 'just', 'already', 'still', 'yet',
  'please', 'help', 'find', 'show', 'get', 'tell', 'give', 'make',
  'not', 'no', 'yes', 'also', 'too', 'very', 'really', 'here', 'there',
  'so', 'up', 'out', 'like', 'than', 'other', 'only',
  // Curated Chinese stop words: pronouns, function words, connectives,
  // question and request words, and time/state particles.
  '的', '了', '是', '在', '和', '与', '及', '或', '也', '都', '有', '就',
  '我', '你', '他', '她', '它', '们', '这', '那', '等',
  '什么', '怎么', '为什么', '如何', '请', '帮', '做',
  '一下', '一个', '我们', '你们', '他们', '然后', '但是', '因为', '所以',
  '如果', '还有', '已经', '现在', '目前', '关于', '进行', '使用',
  '应该', '需要', '是否', '可以',
])

/** Maximal runs of CJK Han ideographs, segmented for FTS indexing. */
const CJK_HAN_RUN = /\p{Script=Han}+/gu

/** Deterministic Han word segmenter shared by the index and query sides. */
const cjkSegmenter = new Intl.Segmenter('zh', { granularity: 'word' })

/**
 * Insert spaces between CJK Han words so the FTS5 `unicode61` tokenizer
 * produces separate tokens for them. Non-Han text passes through verbatim,
 * preserving ASCII identifiers and existing English tokenization. The index
 * and query sides both run this function, so a query term always matches the
 * tokens a chunk was indexed with.
 * @param text - raw text to prepare for FTS tokenization.
 * @returns the text with Han words separated by single spaces.
 */
export function segmentForIndex(text: string): string {
  let output = ''
  let cursor = 0
  for (const match of text.matchAll(CJK_HAN_RUN)) {
    output += text.slice(cursor, match.index)
    const tokens: string[] = []
    for (const segment of cjkSegmenter.segment(match[0])) tokens.push(segment.segment)
    output += tokens.join(' ')
    cursor = match.index + match[0].length
  }
  return output + text.slice(cursor)
}

/** Extract FTS keywords from a conversational query by removing stop words.
 * CJK Han runs are segmented first so Chinese queries yield searchable terms.
 * Tokens shorter than two characters and pure-numeric tokens are dropped so
 * meaningful short terms like `js`, `ui`, `db`, `ai` survive while noise does
 * not; `_` is kept inside tokens to match identifiers like `my_function`.
 * @param query - free-text query.
 * @returns deduplicated lowercase keyword terms.
 */
export function extractKeywords(query: string): string[] {
  const lowered = segmentForIndex(query.toLowerCase())
  const tokens = lowered.split(/[^\p{Script=Han}a-z0-9_]+/u).filter(token => token.length > 1)
  const seen = new Set<string>()
  const result: string[] = []
  for (const token of tokens) {
    if (STOP_WORDS.has(token) || seen.has(token)) continue
    if (/^[0-9]+$/.test(token)) continue
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
