# Curated Memory

English | [中文](memory.zh.md)

The cross-session curated-memory capability — a [capability seam](../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md) that persists knowledge an agent chooses to remember across sessions and surfaces it back through keyword recall, split across packages: Service Definition ([dsh-memory](../../packages/memory/memory), `ctx.memory`), Service Provider ([dsh-memory-markdown](../../packages/memory/memory-markdown), markdown files under the harness home with an SQLite FTS5 index), and Consumer ([dsh-tool-memory](../../packages/memory/tool-memory), the `memory_search`/`memory_get`/`memory_set` tools and session-start injection). Memory is **one optional capability**, not part of the agent-loop spine — so its vocabulary lives here, not in [core.md](core.md).

Source: [`packages/memory/memory/src/index.ts`](../../packages/memory/memory/src/index.ts)

## Scopes and layout

Curated memory has three scopes. `global` holds knowledge shared across every workspace and session; `workspace` is scoped to one project checkout; `session` holds per-session archives. The markdown provider resolves `global` files to the harness home root and `workspace` files to a directory derived from a stable hash of the resolved workspace path, so two checkouts of one project share one memory without storing plaintext workspace paths. A memory file is addressed by a branded `MemoryPath`: `MEMORY.md` at the global or workspace root, or a dated session archive under `sessions/`.

```ts type-equiv
/** Curated-memory scope; `session` chunks decay, evergreen scopes do not. */
type MemoryScope = 'global' | 'workspace' | 'session'
```

```ts type-equiv
/** Opaque identity of one memory file, branded to prevent cross-boundary confusion with plain paths. */
type MemoryPath = Branded<'MemoryPath'>
```

## Chunking and indexing

Files are split into chunks that respect markdown structure — headers, paragraphs, and code blocks — and each chunk carries the active header stack as context for self-containment. A deterministic content hash identifies a chunk across reindexes of unchanged text; a chunk records its 0-based start and exclusive end lines in the source file. The provider stores chunks in a dedicated SQLite index whose schema version and application id protect it from unrelated databases, and indexes the chunk text with a contentless FTS5 table. The shipped recall path is FTS-only and never imports a vector extension, so a deployment performs zero LLM or embedding calls; vector retrieval is a deferred follow-up.

```ts type-equiv
/** One indexed chunk of a memory file. */
interface MemoryChunk {
  /** Deterministic content hash, stable across reindexes of unchanged text. */
  readonly id: MemoryChunkId
  /** Owning memory file path. */
  readonly path: MemoryPath
  /** 0-based start line in the source file. */
  readonly startLine: number
  /** 0-based end line (exclusive) in the source file. */
  readonly endLine: number
  /** Chunk text including ancestor header context. */
  readonly text: string
  /** Curated scope the owning file belongs to. */
  readonly source: MemoryScope
  /** Number of times the chunk appeared in recall results. */
  readonly accessCount: number
  /** Creation epoch millisecond. */
  readonly createdAt: number
}
```

## Scoring

The markdown provider ranks FTS matches by position within the keyword-scan result set, then applies the service's configured pipeline: evergreen scopes (`global`, `workspace`) keep their base score, `session` chunks decay exponentially with a configurable half-life (default 30 days), and each scope carries a weight with an access-frequency boost capped at 0.2. The merged score is clamped to `[0, 1]`; results below `minScore` are dropped. Chunks that are structurally empty or that match boilerplate scaffolding templates (`this file is managed`, `auto-generated`, `do not edit`, `curated knowledge`) never surface in results or injection.

```ts type-equiv
/** Retrieval mode selected by the search pipeline. */
type MemoryRetrievalMode = 'fts-only' | 'hybrid' | 'embedding-fallback'
```

```ts type-equiv
/** One memory search result. */
interface MemorySearchResult {
  readonly chunk: MemoryChunk
  /** Merged score clamped to `[0, 1]`. */
  readonly score: number
  /** Rendering-friendly snippet with match highlighting stripped. */
  readonly snippet: string
  /** Retrieval mode actually used for this query. */
  readonly mode: MemoryRetrievalMode
}
```

## Session-start injection

`ctx.memory.inject()` returns the top evergreen chunks ranked by access count then creation time, excluding content-free chunks. The consumer injects up to `maxInjectedChunks` of them into each session start as a "Project memory" snapshot under a `plugin` message source, so a fresh session opens with the durable conclusions prior sessions chose to record. Injection is best-effort: a provider failure is logged and the session continues without the snapshot.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxmemory--memoryservice-abstract-seam"></a>

### `ctx.memory` — `MemoryService` (abstract seam)

Unified cross-session memory service.

Search, read, write, and list are backend-independent concrete contracts; a backend implements storage, indexing, and retrieval on the same `ctx.memory` service.

```ts cordis-catalog
/**
 * Search curated memory with the FTS keyword pipeline.
 * @param request - query, optional scope/limit/min-score overrides, cancellation.
 * @returns ranked results with per-result mode and coverage metadata.
 */
abstract search(request: MemorySearchRequest): Promise<MemorySearchPage>

/**
 * Read the current content of one memory file.
 * @param path - branded memory file path.
 * @returns the file's full text.
 * @throws {@link MemoryError} `MEMORY_FILE_NOT_FOUND` when absent.
 */
abstract read(path: MemoryPath): Promise<string>

/**
 * Write one memory file, replacing existing content atomically.
 * @param path - branded memory file path.
 * @param content - new full text content.
 */
abstract write(path: MemoryPath, content: string): Promise<void>

/**
 * List known memory files with size and modification metadata.
 * @returns files in deterministic order.
 */
abstract list(): Promise<readonly MemoryFile[]>

/**
 * Return the chunks of one memory file, refreshed from durable state.
 * @param path - branded memory file path.
 * @returns current chunks in document order.
 * @throws {@link MemoryError} `MEMORY_FILE_NOT_FOUND` when absent.
 */
abstract readChunks(path: MemoryPath): Promise<readonly MemoryChunk[]>

/**
 * Return top evergreen chunks for session-start injection.
 * @param request - maximum chunk count and optional cancellation.
 * @returns evergreen chunks ranked for injection, content-free chunks excluded.
 */
abstract inject(request: MemoryInjectRequest): Promise<readonly MemoryChunk[]>
```

Source: [`packages/memory/memory/src/index.ts:55`](../../packages/memory/memory/src/index.ts)
<!-- END GENERATED cordis-surface -->