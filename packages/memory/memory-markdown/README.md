# @deepseek-ai/dsh-memory-markdown

English | [中文](README.zh.md)

The **markdown-backed memory Service Provider**: implements `ctx.memory` over editable markdown files under the harness home, indexed with SQLite FTS5 for keyword search. The shipped path is FTS-only with zero LLM or embedding calls; vector retrieval is a deferred follow-up.

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
| (service keys) | see `dsh-memory` | Search and scoring configuration inherited from the Service Definition. |

`workspace` is required and must not be blank. `openAt: never` disables search and injection: calls reject with `MEMORY_INVALID_CONFIG` explaining that the deployment configured the index as never-open.

## Session archives

On each session flush, the provider writes a summary card for sessions that clear the archive gate: at least three real user queries (excluding plugin- and goal-injected sources) with a total length of at least 50 bytes, and an origin other than `subagent`. The card lands at `sessions/{date}-{slug}-{sid8}.md`, where `date` is the session creation date in UTC, `slug` the first real user query lowercased and collapsed to `[a-z0-9-]` (truncated to 30 characters, `session` when empty), and `sid8` the first 8 hex digits of the `blake2b512` digest of the session id — a stable id-derived suffix that keeps the filename deterministic without leaking the full session id. The card is a what-happened summary in the frozen-index-chunk style (message counts, creation date, and the first five real queries), never a transcript: the transcript already lives in the session log. A later flush of the same session rewrites the same filename, so the card always reflects the cumulative session; the final flush before exit leaves the full summary searchable by the next process. `saveOnEnd: false` disables archiving entirely.

## Indexing and recall

On open, the provider scans the layout roots and reindexes every `.md` file, dropping index rows for files that no longer exist on disk. Each write reindexes the written file; in-memory state is refreshed lazily on read. Chunk text is indexed with a contentless FTS5 table (`unicode61` tokenizer). Search extracts keywords by removing an English stop-word set, dropping single-character and pure-numeric tokens while preserving meaningful short terms and underscored identifiers, runs a quoted-term FTS5 scan over a candidate window of `limit * candidateMultiplier` rows, drops content-free matches, ranks the surviving content-bearing chunks by position, then applies the service's scoring pipeline (scope weights, temporal decay for session chunks, access boost) and returns the top `limit`. A chunk's `accessCount` is incremented when it appears in a search result.

## Model Experience

### Memory recall and injection

#### What the model sees

This package contributes no model-visible text directly; it produces the `MemoryChunk` records that the consumer renders as search results and injected "Project memory" snapshots. Search results carry the chunk's scope, score, and path; snippets are rendered from the chunk's first substantive line.

#### Token effect

The provider stores and indexes full chunk text but never sends it to the model on its own. Search returns at most the configured result cap; injection returns at most `maxInjectedChunks` headlines. Recall cost scales with the number of recalled chunks, each bounded by the chunk configuration.

#### KV Cache effect

The provider writes no model requests. Recall is triggered by the consumer, whose results follow the reusable request prefix.

## Known Limitations and Deferred Work

- **FTS-only** — the vector path (`chunks_vec` table, hybrid scoring, MMR re-ranking) is a deferred follow-up; every search is `fts-only` with zero LLM or embedding calls.
- **English stop words only** — keyword extraction removes a fixed English stop-word set; non-English queries tokenize with no language-specific filtering.
- **No file watcher** — external edits to a memory file are visible to `read` (which refreshes state), but the index is refreshed on the next open or the next `write` reindex, not on an in-process change event.