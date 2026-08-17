/**
 * Model-facing rendering for memory tool calls and results.
 *
 * @module @deepseek-ai/dsh-tool-memory/presentation
 */

import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import type { MemorySearchPage, MemorySearchResult } from '@deepseek-ai/dsh-memory'

/** Render a search page as compact knowledge cards.
 * @param page - memory search page.
 * @returns the rendered card list.
 */
export function renderSearchPage(page: MemorySearchPage): string {
  if (page.results.length === 0) return 'No memory matched the query.'
  const lines = [`Memory search results (${page.results.length}):`]
  for (const [index, result] of page.results.entries()) {
    lines.push(renderResult(index + 1, result))
  }
  return lines.join('\n')
}

function renderResult(index: number, result: MemorySearchResult): string {
  const chunk = result.chunk
  return `[${index}] (${chunk.source}, score ${result.score.toFixed(3)})\n`
    + `path: ${chunk.path}\n`
    + result.snippet
}

/** Present a pending `memory_search` call.
 * @param args - model-supplied search arguments.
 * @returns the generic call view.
 */
export function presentSearchCall(args: { query: string; scope?: string }): GenericCallView {
  const scope = args.scope === undefined ? 'all scopes' : args.scope
  return { card: 'generic', title: 'Search memory', rawInput: `query ${JSON.stringify(args.query)} in ${scope}` }
}

/** Present a pending `memory_get` call.
 * @param args - model-supplied path argument.
 * @returns the generic call view.
 */
export function presentGetCall(args: { path: string }): GenericCallView {
  return { card: 'generic', title: 'Read memory file', rawInput: args.path }
}

/** Present a pending `memory_set` call.
 * @param args - model-supplied path argument.
 * @returns the generic call view.
 */
export function presentSetCall(args: { path: string }): GenericCallView {
  return { card: 'generic', title: 'Write memory file', rawInput: args.path }
}
