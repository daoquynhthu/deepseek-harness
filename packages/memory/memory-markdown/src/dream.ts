/**
 * Dream consolidation: the gated background LLM pass that consolidates session
 * archives into curated workspace memory. This module holds the prompt, the
 * pass gates, and the section rendering; the provider orchestrates the pass
 * and owns the durable state in the `meta` index table.
 *
 * @module @deepseek-ai/dsh-memory-markdown
 */

import type { FinishReason } from '@deepseek-ai/dsh-llm'

/** The consolidation system prompt; the fixed template makes a logged dream request reconstructable. */
export const MEMORY_DREAM_SYSTEM_PROMPT = `You consolidate archived session summaries into durable project knowledge.
Read the provided session summary cards and the current workspace memory.
Extract the durable, reusable facts about the project that are not already
covered by the current workspace memory. Ignore transient details, personal
opinions, and one-off tasks. Output a markdown bullet list, one self-contained
fact per bullet, written as a declarative statement. Do not invent facts.
Output only the bullets, with no preamble, heading, or code fence.`

/** `meta` key holding the ISO timestamp of the last successful dream pass. */
export const MEMORY_DREAM_META_LAST_RUN = 'dream_last_run'

/** `meta` key holding the JSON array of archive filenames consolidated so far. */
export const MEMORY_DREAM_META_CONSUMED = 'dream_consumed'

/** Result of applying the dream gates to the current archive set. */
export interface DreamSelection {
  /** Archive filenames to consolidate, oldest session date first. */
  readonly selected: readonly string[]
  /** True when the pass must not run under the configured gates. */
  readonly skip: boolean
}

/**
 * Apply the dream gates: a pass runs only when at least `minNewArchives`
 * archives have not been consolidated yet AND the previous pass is at least
 * `intervalHours` old. Selection is oldest-first and capped at
 * `maxArchivesPerPass` so older sessions consolidate before newer ones.
 * @param archives - existing session-archive filenames.
 * @param consumed - archive filenames already consolidated.
 * @param minNewArchives - minimum un-consolidated archives before a pass runs.
 * @param maxArchivesPerPass - maximum archives selected per pass.
 * @param intervalHours - minimum hours between passes.
 * @param nowMs - current epoch milliseconds.
 * @param lastRunMs - epoch of the previous pass, or `undefined` for the first.
 * @returns the selected archives and whether the pass is skipped.
 */
export function computeDreamSelection(
  archives: readonly string[],
  consumed: ReadonlySet<string>,
  minNewArchives: number,
  maxArchivesPerPass: number,
  intervalHours: number,
  nowMs: number,
  lastRunMs: number | undefined,
): DreamSelection {
  const fresh = [...archives].sort().filter(name => !consumed.has(name))
  if (fresh.length < minNewArchives) return { selected: [], skip: true }
  if (lastRunMs !== undefined && nowMs - lastRunMs < intervalHours * 3_600_000) return { selected: [], skip: true }
  return { selected: fresh.slice(0, maxArchivesPerPass), skip: false }
}

/**
 * Build the consolidation request texts.
 * @param existing - current workspace memory content, or `undefined` when the file does not exist.
 * @param cards - the session archive cards to consolidate, in order.
 * @returns the system and user prompts for the consolidation call.
 */
export function dreamPrompt(existing: string | undefined, cards: readonly string[]): { system: string; user: string } {
  const cardsText = cards.join('\n\n---\n\n')
  const user = existing === undefined
    ? `Session summary cards to consolidate:\n\n${cardsText}`
    : `Current workspace memory:\n${existing}\n\nSession summary cards to consolidate:\n\n${cardsText}`
  return { system: MEMORY_DREAM_SYSTEM_PROMPT, user }
}

/**
 * Render the markdown section appended to workspace memory for one pass.
 * @param date - the `YYYY-MM-DD` pass date in UTC.
 * @param output - the model's bullet list.
 * @returns the appended section, ending in a single trailing newline.
 */
export function renderDreamSection(date: string, output: string): string {
  return `## Dream consolidation — ${date}\n\n${output}\n`
}

/**
 * Translate terminal finish reasons into a dream-pass failure.
 * @param finish - the assembled terminal finish reason.
 * @returns an error describing the failure, or `undefined` for a clean stop.
 */
export function dreamFinishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'stop':
      return undefined
    case 'error':
    case 'aborted': {
      const error = new Error(finish.failure.message) as Error & { code?: string }
      error.code = finish.failure.code
      return error
    }
    case 'max-tokens':
      return new Error('memory: dream consolidation output reached the token cap')
    case 'tool-calls':
      return new Error('memory: dream consolidation model unexpectedly requested a tool')
    default:
      return new Error(`memory: unsupported dream finish reason "${String((finish as { kind?: unknown }).kind)}"`)
  }
}
