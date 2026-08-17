/**
 * Session-end archive synthesis: real-query extraction, the substantiality
 * gate, the metadata card, and deterministic archive naming.
 *
 * The card is a zero-LLM metadata summary mirroring the grok `on_session_end`
 * design: message counts, the session date, and the first few real user
 * topics. Real user queries exclude injected plugin content and goal rounds.
 *
 * @module @deepseek-ai/dsh-memory-markdown/archive
 */

import { createHash } from 'node:crypto'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Minimum number of real user prompts before a session is archived. */
export const MEMORY_ARCHIVE_MIN_USER_MESSAGES = 3
/** Minimum total byte length of real user queries before a session is archived. */
export const MEMORY_ARCHIVE_MIN_QUERY_BYTES = 50
/** Maximum topics rendered in one archive card. */
export const MEMORY_ARCHIVE_MAX_TOPICS = 5
/** Maximum characters of each rendered topic. */
export const MEMORY_ARCHIVE_TOPIC_MAX_CHARS = 100
/** Maximum slug characters derived from the first real user query. */
export const MEMORY_ARCHIVE_SLUG_MAX_CHARS = 30

/** Message counts rendered in a session archive card. */
export interface ArchiveMessageCounts {
  /** Count of real user prompts. */
  readonly user: number
  /** Count of assistant messages. */
  readonly assistant: number
  /** Count of tool results. */
  readonly toolResults: number
}

/** `YYYY-MM-DD` filename date plus the card's `YYYY-MM-DD HH:MM UTC` stamp. */
export interface ArchiveDateParts {
  /** Filename date segment, e.g. `2026-08-17`. */
  readonly date: string
  /** Card stamp, e.g. `2026-08-17 14:30 UTC`. */
  readonly stamp: string
}

/**
 * Extract every real user query text from a session log. Real prompts are
 * `user/message` events whose source kind is `user`; injected plugin context
 * and goal rounds are excluded, mirroring grok's exclusion of synthetic
 * prefixes and auto-continue sentinels.
 * @param events - the session's event log.
 * @returns the real user query texts in log order.
 */
export function realUserQueryTexts(events: readonly SessionEvent[]): string[] {
  const queries: string[] = []
  for (const event of events) {
    if (event.type !== 'user/message') continue
    const source = event.data.source
    if (source.kind !== 'user') continue
    const text = event.data.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    queries.push(text)
  }
  return queries
}

/**
 * Count the messages a session produced for its archive card.
 * @param events - the session's event log.
 * @returns the user, assistant, and tool-result counts.
 */
export function archiveMessageCounts(events: readonly SessionEvent[]): ArchiveMessageCounts {
  let user = 0
  let assistant = 0
  let toolResults = 0
  for (const event of events) {
    if (event.type === 'user/message') {
      if (event.data.source.kind === 'user') user += 1
    } else if (event.type === 'assistant/message') {
      assistant += 1
    } else if (event.type === 'tool/result') {
      toolResults += 1
    }
  }
  return { user, assistant, toolResults }
}

/**
 * Whether a session meets the session-end archive gate: enough real user
 * prompts and enough total query bytes. Mirrors grok's
 * `queries_meeting_session_end_threshold`.
 * @param queries - the session's real user query texts.
 * @returns `true` when the session is substantial enough to archive.
 */
export function meetsSessionArchiveGate(queries: readonly string[]): boolean {
  if (queries.length < MEMORY_ARCHIVE_MIN_USER_MESSAGES) return false
  const totalBytes = queries.reduce((sum, query) => sum + Buffer.byteLength(query, 'utf8'), 0)
  return totalBytes >= MEMORY_ARCHIVE_MIN_QUERY_BYTES
}

/**
 * Slugify a string for an archive filename: lowercase, non-ASCII-alphanumeric
 * characters become `-`, consecutive dashes collapse, the result truncates to
 * `maxLen` characters, and leading/trailing dashes are trimmed. Faithful to
 * grok's `slugify`.
 * @param input - the source text.
 * @param maxLen - maximum slug length in characters.
 * @returns the slug.
 */
export function slugify(input: string, maxLen: number): string {
  let result = ''
  let prevDash = false
  for (const char of input.toLowerCase()) {
    if (/[a-z0-9]/.test(char)) {
      result += char
      prevDash = false
    } else if (!prevDash) {
      result += '-'
      prevDash = true
    }
  }
  return result.slice(0, maxLen).replace(/^-+|-+$/g, '')
}

/**
 * Split a session epoch into its filename date and card stamp, both in UTC.
 * @param epochMs - session creation epoch millisecond.
 * @returns the date and stamp parts.
 */
export function archiveDateParts(epochMs: number): ArchiveDateParts {
  const iso = new Date(epochMs).toISOString()
  return {
    date: iso.slice(0, 10),
    stamp: `${iso.slice(0, 16).replace('T', ' ')} UTC`,
  }
}

/**
 * Derive the deterministic 8-hex-character suffix for an archive filename from
 * a session id. Raw session ids are `session-N` and would violate the archive
 * name's `[a-z0-9]{8}` suffix, so the suffix is a hash of the id.
 * @param sessionId - the session's id.
 * @returns 8 lowercase hex characters.
 */
export function sessionArchiveSid8(sessionId: string): string {
  return createHash('blake2b512').update(sessionId, 'utf8').digest('hex').slice(0, 8)
}

/**
 * Build an archive filename, satisfying the `YYYY-MM-DD-{slug}-{sid8}.md`
 * archive name contract.
 * @param date - `YYYY-MM-DD` session date.
 * @param slug - slug derived from the first real user query.
 * @param sid8 - 8-hex-character session id suffix.
 * @returns the archive filename.
 */
export function sessionArchiveName(date: string, slug: string, sid8: string): string {
  return `${date}-${slug}-${sid8}.md`
}

/**
 * Render the zero-LLM metadata card for a session archive, mirroring grok's
 * `generate_metadata_summary`.
 * @param stamp - the `YYYY-MM-DD HH:MM UTC` session stamp.
 * @param counts - the session's message counts.
 * @param topics - the first real user queries to list.
 * @returns the card markdown.
 */
export function renderArchiveCard(stamp: string, counts: ArchiveMessageCounts, topics: readonly string[]): string {
  const lines = [
    '## Session Summary',
    '',
    `- **Messages:** ${counts.user} user, ${counts.assistant} assistant, ${counts.toolResults} tool results`,
    `- **Date:** ${stamp}`,
    '',
  ]
  if (topics.length > 0) {
    lines.push('## Topics Discussed', '')
    for (const [index, topic] of topics.entries()) {
      lines.push(`${index + 1}. ${topic}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}
