/**
 * Dream-consolidation vocabulary: the `memory/dream` session event.
 * The declaration-merged event records the consolidation LLM request and its
 * output without entering the surface; the appended workspace-memory block is
 * the durable, model-visible artifact and lives on disk, not in the log.
 *
 * @module @deepseek-ai/dsh-memory-markdown/types
 */

/**
 * One dream-consolidation pass: the archives it consumed, the LLM request it
 * made, and the markdown block it appended to workspace memory — log-only, no
 * surfaceOp. The request is reconstructable from this event plus the fixed
 * prompt template in `src/dream.ts`.
 */
export interface DreamEventPayload {
  /** The provider route that wrote the consolidation. */
  route: { provider: string; model: string }
  /** Session-archive filenames consolidated by the pass, in filename order. */
  archives: string[]
  /** The consolidation system prompt sent to the model. */
  system: string
  /** The consolidation user message: existing workspace memory plus the archive cards. */
  user: string
  /** The generated markdown block appended to `workspace/MEMORY.md`. */
  output: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Completed dream consolidation — log-only, no surfaceOp. The durable
     * output is the block appended to `workspace/MEMORY.md` on disk.
     */
    'memory/dream': DreamEventPayload
  }
}
