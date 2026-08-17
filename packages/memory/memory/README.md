# @deepseek-ai/dsh-memory

English | [中文](README.zh.md)

The **curated-memory Service Definition**: a backend-independent `ctx.memory` service that stores and recalls knowledge an agent chooses to remember across sessions. Search, read, write, list, chunk read, and session-start injection are concrete abstract contracts; a backend supplies storage, indexing, and retrieval. The shipped backend is [`@deepseek-ai/dsh-memory-markdown`](../memory-markdown); the model-facing consumer is [`@deepseek-ai/dsh-tool-memory`](../tool-memory).

This package defines the service, the memory-path and chunk vocabulary, and the scoring pipeline shared by every backend. It owns no storage.

## Service API

`MemoryService` (`ctx.memory`) has these operations:

| Member | Meaning |
|---|---|
| `search(request)` | Run the FTS keyword search pipeline and return ranked results with per-result retrieval mode and coverage metadata. Optional `scope`, `limit`, and `minScore` override the service configuration; `signal` cancels. |
| `read(path)` | Return the current content of one memory file. Rejects with `MEMORY_FILE_NOT_FOUND` when absent. |
| `write(path, content)` | Replace one memory file's content atomically. |
| `list()` | Return known memory files with size and modification metadata, in deterministic order. |
| `readChunks(path)` | Return the current chunks of one memory file, refreshed from durable state. |
| `inject(request)` | Return top evergreen chunks for session-start injection, excluding content-free chunks. |

## Memory paths

A `MemoryPath` is a [branded](../../../docs/subsystems/core.md#branded-ids) identity whose string encodes its scope root, so the opaque handle stays self-describing across storage and index rows:

| Path | Scope | Location |
|---|---|---|
| `MEMORY.md` | `global` | harness-home memory root |
| `workspace/MEMORY.md` | `workspace` | workspace-hash directory |
| `sessions/YYYY-MM-DD-{slug}-{sid8}.md` | `session` | workspace-hash `sessions/` |

The path factory rejects any other path, keeping model write authority narrow. See the [memory subsystem page](../../../docs/subsystems/memory.md) for the full vocabulary.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `maxResults` | `10` | Maximum results returned by one search. |
| `minScore` | `0.1` | Minimum accepted score; lower-scoring chunks are dropped. |
| `temporalDecayEnabled` | `true` | Apply exponential decay to `session` chunks when enabled. |
| `halfLifeDays` | `30` | Decay half-life in days; `lambda = ln(2) / halfLifeDays`. |
| `sourceWeights` | `{ global: 1, workspace: 1, session: 1 }` | Per-scope score weights. |
| `candidateMultiplier` | `3` | Multiplier applied to the result cap to size the FTS candidate window before content-free filtering. |

## Scoring pipeline

The merged score is computed from the FTS position base through the shared `scoring.ts` helpers: evergreen scopes (`global`, `workspace`) keep their base score, `session` chunks decay exponentially by age with the configured half-life, each scope's weight scales the result, and an access-frequency boost (capped at 0.2) rewards chunks that appeared in recall. The score is clamped to `[0, 1]`. Content-free chunks — structurally empty text or evergreen boilerplate scaffolding — never surface in results or injection. Backends fetch up to `limit * candidateMultiplier` candidate rows, drop content-free matches first, then compute the position base over the surviving content-bearing chunks so scaffolding cannot crowd out real matches within the result cap.

## Errors

Typed `MemoryError` failures carry a stable machine-routable code:

| Code | Meaning |
|---|---|
| `MEMORY_INVALID_CONFIG` | A configuration or request bound is invalid. |
| `MEMORY_FILE_NOT_FOUND` | The addressed memory file does not exist. |
| `MEMORY_INVALID_PATH` | The path is not an allowed memory path. |
| `MEMORY_ABORTED` | The request was aborted. |

## Model Experience

### Memory injection and recall

#### What the model sees

The model sees the results, files, and chunks returned by the consumer's tools and injection — this package contributes no model-visible text of its own. `memory_search` returns ranked knowledge cards with scope, score, and path; `memory_get` returns a full file; `memory_set` returns a write acknowledgment. Session-start injection presents a "Project memory" snapshot of top evergreen chunks.

#### Token effect

Injection adds up to `maxInjectedChunks` chunk headlines at session start; search results are bounded by `maxResults` and each snippet is capped. Written memory is indexed but is not resent to the model until recalled.

#### KV Cache effect

Injection happens at the session start, before the model's first turn, so it joins the reusable request prefix. Search and read results are per-call content that follows the prefix and does not invalidate existing cache entries.

## Known Limitations and Deferred Work

- **The shipped backend is FTS-only** — vector retrieval and hybrid scoring are deferred follow-ups; every search is `fts-only` with zero LLM or embedding calls. See the cross-session memory Agent Note's follow-ups for the deferred vector path.
- **No consolidation or forgetting** — memory is curated by explicit `memory_set` writes and search-driven access counts; there is no background "dream" pass, file watcher, or automatic promotion from session archives.