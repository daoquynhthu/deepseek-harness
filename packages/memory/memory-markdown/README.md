# @deepseek-ai/dsh-memory-markdown

English | [中文](README.zh.md)

The **markdown-backed memory Service Provider**: implements `ctx.memory` over editable markdown files under the harness home, indexed with SQLite FTS5 for keyword search. The shipped path is FTS-only with zero LLM or embedding calls; vector retrieval is not planned.

This package owns storage, indexing, and retrieval for the curated-memory seam. The service contract lives in [`@deepseek-ai/dsh-memory`](../memory); the model-facing consumer is [`@deepseek-ai/dsh-tool-memory`](../tool-memory).

## Layout

The memory root resolves through the harness home (`{dshHome}/memory`, overridable via `root`). Workspace-scoped files live under a directory derived from a stable hash of the resolved workspace path, so two checkouts of one project share one memory without storing plaintext workspace paths.

```
{dshHome}/memory/
  MEMORY.md                              # global curated knowledge
  {workspace_hash}/
    MEMORY.md                            # project-level curated knowledge
    sessions/YYYY-MM-DD-{slug}-{sid8}.md # archived session summaries
    index.sqlite                         # chunk index: FTS5 keyword search
```

The index database is a dedicated SQLite file created owner-only (`0600`). Its schema version and application id protect it from unrelated databases: an unrecognized derived index or a foreign application id fails loud instead of being reset silently.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `index.maxChunkChars` | `800` | Maximum chunk size in characters. |
| `index.chunkOverlapChars` | `120` | Overlap in characters between continuation chunks. |
| `openAt` | `startup` | Open the SQLite index at activation (`startup`), the first search (`first-search`), or `never`. |
| `journalMode` | `wal` | SQLite journal mode (`wal`, `delete`, `truncate`, `persist`). |
| `root` | *(omitted)* | Explicit memory root; defaults to `{dshHome}/memory`. |
| `workspace` | *(required)* | Workspace path used to derive the workspace memory directory. |
| `dshHome` | *(omitted)* | Explicit harness home override. |
| `path` | *(omitted)* | Memory index database path; defaults to `{root}/index.sqlite`. |
| `session.saveOnEnd` | `true` | Archive substantial sessions to the workspace sessions directory. |
| `session.retentionDays` | *(omitted)* | Prune session archives whose session date is older than this many days; off when omitted. |
| `watcher.enabled` | `false` | Watch memory directories and refresh the index on external edits. |
| `watcher.debounceMs` | `100` | Milliseconds to coalesce rapid file-system events. |
| `watcher.pollIntervalMs` | `5000` | Milliseconds between polling probes when native watching is unavailable. |
| `dream.enabled` | `false` | Consolidate session archives into workspace memory in a background LLM pass; requires the `dsh-llm` runtime. |
| `dream.intervalHours` | `24` | Minimum hours between dream passes. |
| `dream.minNewArchives` | `3` | Minimum number of un-consumed session archives to trigger a pass. |
| `dream.maxArchivesPerPass` | `10` | Maximum archives consolidated per pass, oldest first. |
| `dream.maxTokens` | `1024` | Maximum completion tokens per pass. |
| `dream.provider` / `dream.model` | *(omitted)* | Provider/model pair for the pass; when omitted, falls back to the session's routed pair. |
| (service keys) | see `dsh-memory` | Search and scoring configuration inherited from the Service Definition. |

`workspace` is required and must not be blank. `openAt: never` disables search and injection: calls reject with `MEMORY_INVALID_CONFIG` explaining that the deployment configured the index as never-open. `dream.provider` and `dream.model` must be supplied together and must be non-empty; the dream tunables must be positive safe integers.

## Dream consolidation

When `dream.enabled` is set, the provider runs a background pass after each session flush to consolidate un-consumed session archives into the workspace `MEMORY.md`. The pass triggers only when both gates clear: at least `minNewArchives` archives have not been consolidated yet, and at least `intervalHours` have passed since the last pass (a pass with no recorded run time always runs). It reads the oldest archives first, up to `maxArchivesPerPass`, builds a system prompt from their cards plus the current `MEMORY.md`, streams a completion over the configured provider/model pair (falling back to the session's routed pair), and appends a `## Dream consolidation — {date}` section to `MEMORY.md`, creating the file with a `# Workspace memory` header when absent. On success the pass records the consumed archive names and the run time in the SQLite `meta` table, so a repeat pass skips them. An empty completion is a success that appends nothing; a failed completion warns, appends nothing, and leaves the archives un-consumed so the next pass retries. The pass is best-effort: concurrent triggers coalesce, and a missing `dsh-llm` runtime or an unavailable route skips with a warning rather than failing the flush. The `memory/dream` session event records the route, archives, rendered prompt, and output for reconstruction.

## Session archives

On each session flush, the provider writes a summary card for sessions that clear the archive gate: at least three real user queries (excluding plugin- and goal-injected sources) with a total length of at least 50 bytes, and an origin other than `subagent`. The card lands at `sessions/{date}-{slug}-{sid8}.md`, where `date` is the session creation date in UTC, `slug` the first real user query lowercased and collapsed to `[a-z0-9-]` (truncated to 30 characters, `session` when empty), and `sid8` the first 8 hex digits of the `blake2b512` digest of the session id — a stable id-derived suffix that keeps the filename deterministic without leaking the full session id. The card is a what-happened summary in the frozen-index-chunk style (message counts, creation date, and the first five real queries), never a transcript: the transcript already lives in the session log. A later flush of the same session rewrites the same filename, so the card always reflects the cumulative session; the final flush before exit leaves the full summary searchable by the next process. `saveOnEnd: false` disables archiving entirely.

## Indexing and recall

On open, the provider scans the layout roots and reindexes every `.md` file, dropping index rows for files that no longer exist on disk. When `session.retentionDays` is set, it also deletes session archives whose session date (the `YYYY-MM-DD` filename prefix, UTC) is older than that many days, keeping evergreen `MEMORY.md` files untouched; the transcript lives in the session log, so pruning an archive loses no transcript. Each write reindexes the written file; in-memory state is refreshed lazily on read. With `watcher.enabled`, the provider also watches the layout roots with native file-system events (falling back to periodic polling over `watcher.pollIntervalMs` when native watching is unavailable) and refreshes the index when a memory file changes or disappears outside the provider; non-markdown events such as index writes are ignored so the provider never re-triggers itself. Chunk text is indexed with a contentless FTS5 table (`unicode61` tokenizer); Han runs are pre-segmented into words with `Intl.Segmenter` before indexing and query extraction, so Chinese and English search through the same keyword path. Search extracts keywords by removing a curated English and Chinese stop-word set, dropping single-character and pure-numeric tokens while preserving meaningful short terms and underscored identifiers, runs a quoted-term FTS5 scan over a candidate window of `limit * candidateMultiplier` rows, drops content-free matches, ranks the surviving content-bearing chunks by position, then applies the service's scoring pipeline (scope weights, temporal decay for session chunks, access boost) and returns the top `limit`. A chunk's `accessCount` is incremented when it appears in a search result.

## Model Experience

### Memory recall and injection

#### What the model sees

This package contributes no model-visible text directly; it produces the `MemoryChunk` records that the consumer renders as search results and injected "Project memory" snapshots. Search results carry the chunk's scope, score, and path; snippets are rendered from the chunk's first substantive line.

#### Token effect

The provider stores and indexes full chunk text but never sends it to the model on its own. Search returns at most the configured result cap; injection returns at most `maxInjectedChunks` headlines. Recall cost scales with the number of recalled chunks, each bounded by the chunk configuration.

#### KV Cache effect

The provider writes no model requests. Recall is triggered by the consumer, whose results follow the reusable request prefix.

## Known Limitations and Deferred Work

- **FTS-only** — the vector path (`chunks_vec` table, hybrid scoring, MMR re-ranking) is not planned; every search is `fts-only` with zero LLM or embedding calls.
- **Unknown Chinese compounds are unsearchable** — Han runs are segmented with `Intl.Segmenter` (ICU dictionary) before indexing and query extraction, and a curated Chinese stop-word set filters extraction. Compounds the dictionary does not recognize split per character and drop with single-character tokens, so only dictionary-known Chinese words are searchable.
- **Opt-in file watcher** — external edits to a memory file are visible to `read` (which refreshes state), but the index refresh on external edits requires `watcher.enabled: true`. The watcher uses native file-system events; when native watching is unavailable for a root, it falls back to periodic polling over `watcher.pollIntervalMs`.
- **Opt-in archive retention** — session archives accumulate indefinitely unless `session.retentionDays` is set; pruning runs on open (startup or first-search) and on watcher refreshes.
- **Opt-in dream consolidation** — dream is off by default and requires the `dsh-llm` runtime plus a provider route, so keyless replay stays deterministic; the pass is best-effort (fire-and-forget after flush, coalesced) and a concurrent model write to `MEMORY.md` between the pass's read and append can be overwritten.