/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-memory-markdown`.
 * @module @deepseek-ai/dsh-memory-markdown/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-memory-markdown'

/** Cordis companion plugin name. */
export const name = 'memory-markdown-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: chunk rows derive from durable markdown files, and
 * search results are immutable per-call projections built at the query
 * boundary; the provider retains no observable result state.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
