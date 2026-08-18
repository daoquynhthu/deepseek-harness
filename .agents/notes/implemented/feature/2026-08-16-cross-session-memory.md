# Agent Note: Cross-session memory — curated knowledge persistence with hybrid recall

Status: implemented

English | [中文](2026-08-16-cross-session-memory.zh.md)

## Problem

An agent that only reads its own session log starts from zero in every fresh session. A developer resumes a project across weeks and sessions: conventions, decisions, dependency facts, and project layout live scattered across prior `session_query`-reachable logs, but nothing curates them, nothing surfaces them at session start, and nothing distinguishes "what happened before" from "what this project is". The model must re-derive durable facts from raw transcripts or re-learn them by asking.

The existing seams do not cover this gap. `session_query` (and its `tool-session-query` consumer) retrieves raw session events: full-text search over the conversation record, with no curation, no hierarchy, and no priority. It is the transcript, not the knowledge. Third-party memory MCP servers (the [third-party-memory-mcp-examples](../../implemented/feature/2026-07-31-third-party-memory-mcp-examples.md) boundary) push storage, curation, models, and embeddings upstream and are explicitly out of product scope. `recallable-compaction` (in-session recall) is complementary but scoped to one live session's shadowed spans, not cross-session knowledge. Nothing shipped a product-owned, cross-session knowledge layer.

Grok's memory system (`xai-grok-memory`) is the mature reference: markdown storage under `~/.grok/memory/` with global and per-workspace `MEMORY.md` plus archived session logs, a SQLite index with FTS5 keyword search and optional vector KNN, hybrid scoring with temporal decay and source weighting, initial injection at session start plus model-facing search tools, a file watcher for external edits, and a background dream consolidation. DSH has the SQLite, tool, and injection plumbing; it lacked only the memory layer itself.

## Decision

DSH ships a cross-session memory capability as a new seam: Service Definition `@deepseek-ai/dsh-memory`, markdown provider `@deepseek-ai/dsh-memory-markdown`, and model-facing consumer `@deepseek-ai/dsh-tool-memory`. The capability stores curated knowledge as editable markdown under the harness home, indexes it for hybrid recall, injects relevant memory into session start, and exposes search, read, and write tools to the model.

### Storage layout

```
{dshHome}/memory/
  MEMORY.md                              # global curated knowledge
  {workspace_hash}/                      # per-workspace, blake2b512(cwd) truncated
    MEMORY.md                            # project-level curated knowledge
    sessions/YYYY-MM-DD-{slug}-{sid8}.md # archived session summaries
    index.sqlite                         # chunk index: FTS5 keyword search
```

The root resolves through `dshHomePath('memory')` from `@deepseek-ai/dsh-home-paths`, keeping the harness's single-root rule (`~/.dsh`, overridable via `DSH_HOME`). The workspace directory name is a truncated blake2b512 hash of the workspace path, matching the `session-reference` pattern of opaque ids: no workspace path is stored in plain text, and two checkouts of the same project share one memory.

Three scopes follow grok: `global` (evergreen, all workspaces), `workspace` (evergreen, one project), and `session` (auto-archived session logs, decaying). Evergreen sources are exempt from temporal decay; session chunks decay with the configured half-life.

### Index and hybrid search

`index.sqlite` holds a `chunks` table (relative branded path, start/end line, text, hash, source, access count, timestamps) and a contentless FTS5 virtual table for BM25 keyword search. The search pipeline follows grok's keyword side: FTS keyword search is always available; scores are normalized to `[0,1]`; content-free chunks (empty or scaffold-template `MEMORY.md` stubs) are filtered before scoring, over a candidate window of `maxResults * candidateMultiplier` so scaffolding cannot crowd out real matches within the result cap; temporal decay applies to session chunks only; source weights plus access-frequency boost apply; results are capped by `maxResults`. Keyword extraction pre-segments Han runs into words with `Intl.Segmenter` (ICU dictionary) so Chinese and English search through the same FTS keyword path, removes grok's expanded English stop-word set plus a curated Chinese stop-word set, drops single-character and pure-numeric tokens, and keeps underscored identifiers. The shipped provider is FTS-only with no embedding or vector path: the recall path never depends on an LLM or embedding call, preserving keyless replay determinism (the same constraint that ruled out semantic recall in `recallable-compaction`).

### Initial injection

At session start, the memory plugin queries the index for the session's workspace and injects up to a configured `maxInjectedChunks` of top-scoring evergreen memory into the system prompt as a compact "Project memory" section, alongside the existing `agent-instructions` context. Injection reads the same FTS search path, so it inherits scoring, decay, and content-free filtering. A `minScore` threshold keeps irrelevant noise out. The prompt section is a static string naming the `memory_search` and `memory_get` tools; injected chunks render as readable knowledge cards, not raw event transcripts.

Injection happens once per session, not once per turn: the plugin marks the injected snapshot in the session event stream and later turns reuse that prefix unchanged. This keeps the request header byte-stable across turns and preserves KV-cache prefix reuse; injection never re-sorts or re-filters chunks in ways that would move the prefix mid-session.

### Model-facing tools

`@deepseek-ai/dsh-tool-memory` registers three tools, mirroring the `tool-session-query` split (input validation, service boundary, presentation):

- `memory_search(query, scope?, limit?)` — hybrid search over curated memory chunks; returns snippets with source, path, and coverage metadata. Scope filters global/workspace/session.
- `memory_get(path)` — exact read of one memory file's current content (e.g. `MEMORY.md` or a specific session archive), for follow-up after a search hit.
- `memory_set(path, content)` — appends curated knowledge to an evergreen `MEMORY.md` path, then reindexes.

Search and read reject non-agent callers and never-existing paths with typed errors, and render ordinary `tool/result`s so recall stays reconstructable from the session log. The tool schemas and prompt section are static strings.

The search tools expose prior knowledge rather than the operation performing the search, exactly like `session_search`. The boundary from `tool-session-query` is deliberate: that package searches raw session events; this one searches curated knowledge. A model that needs "what did we say last Tuesday" uses `session_search`; a model that needs "what is this project's convention" uses `memory_search`.

### Write path

Two write paths feed the index:

1. **Curated writes**: `memory_set(path, content)` lets the user or model append curated knowledge to `MEMORY.md`. Writes are markdown edits through the storage layer, then reindexed. `memory_set` accepts only the evergreen paths (`MEMORY.md`, `workspace/MEMORY.md`) and rejects session archives, keeping the write boundary narrower than the read surface. This is the primary path and the one that makes memory trustworthy — the model writes durable conclusions, not raw transcripts.
2. **Session archive**: on each session flush — the durable checkpoint the session store awaits before persisting the log — the plugin writes a bounded what-happened card to `sessions/YYYY-MM-DD-{slug}-{sid8}.md` when the session is substantial (at least three real user queries totaling at least 50 bytes, excluding plugin- and goal-injected sources) and not a subagent, so session-level history becomes searchable without polluting curated knowledge. The session-archive format borrows the frozen-index-chunk idea from `recallable-compaction`: a compact card, not a full transcript (the full transcript already lives in the session log). Archiving hooks the flush checkpoint rather than session disposal because a provider's `session/disposed` listener is torn down before the session detaches during root dispose (the provider fiber unloads first in the root's dispose order), which dropped archives deterministically; flush is awaited by the store, so the write is durable at the checkpoint. A later flush of the same session rewrites the same filename, so the card reflects the cumulative session and the final flush leaves the full summary searchable by a later process. The filename is deterministic: the date from the session's creation time, a slug from the first real user query, and the first 8 hex digits of a blake2b512 digest of the session id (raw session ids are `session-N` and would violate the archive-name `[a-z0-9]{8}` suffix). The card mirrors grok's `generate_metadata_summary`: message counts, the session date, and the first few real user queries.

A file watcher is opt-in: with `watcher.enabled`, the provider watches the layout roots with native file-system events (falling back to periodic polling over `watcher.pollIntervalMs` when native watching is unavailable) and refreshes the index when a memory file changes or disappears outside the provider; non-markdown events such as index writes are ignored so the provider never re-triggers itself. Off by default, external edits to `MEMORY.md` remain visible to the next index open and to `write` reindexes; the memory-markdown README documents the toggle.

Archive retention is opt-in: with `session.retentionDays`, the provider deletes session archives whose session date (the `YYYY-MM-DD` filename prefix, UTC) is older than that many days, dropping the file, its cache entry, and its index rows on open and on watcher refreshes. Evergreen `MEMORY.md` files never match the archive name contract, so pruning touches only session summaries; the transcript stays in the session log, so pruning loses no transcript.

### Dream consolidation

A background LLM pass mirrors grok's `autoDream`: when `dream.enabled` is set (off by default, since it requires the `dsh-llm` runtime and a provider), each session flush afterwards runs a pass that consolidates un-consumed session archives into curated workspace memory. The gates are a minimum number of new archives (`minNewArchives`, default 3) and a minimum interval since the last pass (`intervalHours`, default 24); when both clear, the pass selects the oldest archives first up to `maxArchivesPerPass` (default 10), reads their cards plus the current workspace `MEMORY.md` into a system prompt, streams a model completion (a configured `provider`/`model` pair, falling back to the session's routed pair from the request header), and appends a `## Dream consolidation — {date}` section to `workspace/MEMORY.md`, creating the file with a `# Workspace memory` header when absent. Success records the consumed archive names and the run time in the SQLite `meta` table; a failed or empty completion appends nothing, and a failed completion leaves the archives un-consumed so the next pass retries. The pass is best-effort: it coalesces concurrent triggers, skips silently when the llm runtime or a route is unavailable, and never touches the session log, so a replayed transcript is unchanged. The `memory/dream` session event records the route, archives, and rendered prompt and output for reconstruction.

### Config

All knobs live in each package's `Config`, validated at load:

```
# @deepseek-ai/dsh-memory-markdown
workspace: /path/to/project      # required; drives the workspace memory directory
maxResults: 10
minScore: 0.1
temporalDecayEnabled: true
halfLifeDays: 30
sourceWeights: { global: 1, workspace: 1, session: 1 }
candidateMultiplier: 3
index:
  maxChunkChars: 800
  chunkOverlapChars: 120
openAt: startup                  # or first-search, never
journalMode: wal
session:
  saveOnEnd: true
  retentionDays: 30           # omit to keep session archives forever
watcher:
  enabled: false
  debounceMs: 100
  pollIntervalMs: 5000
dream:
  enabled: false            # requires the llm runtime and a provider route
  intervalHours: 24
  minNewArchives: 3
  maxArchivesPerPass: 10
  maxTokens: 1024
  # provider: dream-provider   # optional pair; falls back to the session's routed pair
  # model: dream-model

# @deepseek-ai/dsh-tool-memory
maxSearchResults: 10
maxInjectedChunks: 5
```

Deployment-varying choices are validated `Config` fields, per the no-hardcoded-tunables rule; the only fixed values are protocol invariants and the DSH-specific `DSH_HOME` resolution.

### Packaging

- `@deepseek-ai/dsh-memory` — Service Definition, `ctx.memory`, exporting the `MemoryService` interface (search, read, write, inject), chunking and scoring helpers, and the type graph. Default-export of the service class per package convention.
- `@deepseek-ai/dsh-memory-markdown` — provider: markdown storage, SQLite index (reusing the harness's `session-persistence-sqlite` sqlite conventions), FTS5, session archiver, and the opt-in dream consolidation pass over the `dsh-llm` runtime.
- `@deepseek-ai/dsh-tool-memory` — Consumer: `memory_search`, `memory_get`, `memory_set` tools plus the prompt section.

The seam follows the [capability-seam pattern](../../implemented/architecture/2026-06-13-capability-seams.md): Definition, Provider, Consumer roles each exist; no role is skipped. The service registers through `ctx.effect()` with HMR-safe disposal.

### Follow-ups

Deferred until observation calls for them:

- **Vector KNN and hybrid scoring are not planned**: the project ships no embeddings endpoint, so vector retrieval, `textWeight`/`vectorWeight`/`mmrEnabled`-style knobs, and semantic search as a default are permanently out of scope. The shipped provider stays FTS-only with zero LLM or embedding calls.
- **Cross-device sync**: memory lives under the harness home with no sync; on observed need, add a syncing layer without touching the provider. Retention GC already ships as opt-in `session.retentionDays` (max-age pruning of session archives on open and on watcher refreshes).

## Consequences

- **FTS-only recall costs semantic recall**: the FTS floor misses semantic matches that vector search would catch. It buys a keyless, dependency-free, deterministic recall path with zero LLM or embedding cost and byte-stable replay. DeepSeek's public API exposes no embeddings endpoint (V4-Pro/V4-Flash are chat-only), and the project ships no embeddings endpoint, so vector retrieval is out of scope rather than a deferred option.
- **Curator dependency**: memory quality depends on the model writing durable conclusions via `memory_set`; untrained models may under-write or over-write. Session-archive and injection give the floor; training-side follow-up (the same dynamic as `recallable-compaction`) is deferred.
- **Context tax**: injected chunks occupy request tokens in every session start. The `maxInjectedChunks`/`minScore` knobs bound it, and the default is small.
- **Editable store drift**: users editing `MEMORY.md` can introduce inconsistencies; content-free filtering contains the search-side effects, and curation is the feature, not a bug.
- **Two search seams**: `tool-session-query` and `tool-memory` both reach past work; the boundary (transcript vs knowledge) is documented in both prompt sections, and the shipped example keeps both opt-in.

## Verification

The keyless headless example covers the full loop end to end: a session writes curated memory via `memory_set`, a fresh session's request header shows the injected "Project memory" section, and a `memory_search` tool call in the fresh session retrieves the written chunk. Request-reconstruction invariants pass over sessions with memory injection and tool recall.

Snapshots and package tests pin the remaining behaviors: `memory_search` finds content that exists only in curated memory with source, path, and coverage metadata while `memory_get` reads the file exactly; a bilingual keyword-recall snapshot verifies Chinese and English terms search through the same FTS path across fresh sessions; both reject non-agent callers and never-existing paths with typed errors; tool schemas and the prompt section are byte-identical across passes; with no embedding config every injection and search is FTS-only with zero LLM or embedding calls; injection fires once per session and the injected request header is byte-stable across later turns (KV-cache prefix reuse); evergreen chunks are exempt from temporal decay, session chunks decay with the configured half-life, reindexing unchanged content preserves chunk creation timestamps, and content-free scaffold chunks never appear in results or injection; search results carry the same relative branded paths accepted by `memory_get`; a substantial session archives to a deterministic `sessions/YYYY-MM-DD-{slug}-{sid8}.md` at its flush (creation-time date, slug, id digest), rewrites on later flushes, is recallable by a fresh process, and `saveOnEnd: false` writes nothing; `session.retentionDays` prunes archives older than the configured window on open while keeping evergreen `MEMORY.md` untouched, and omitting it keeps archives; a dream pass consolidates un-consumed archives oldest-first into workspace memory with a `memory/dream` event, honors the min-count and interval gates, records consumption so repeats skip, falls back to the session's routed pair, coalesces concurrent passes, and leaves archives un-consumed when the model call fails, while the disabled, no-llm, no-route, and never-open paths skip; the opt-in watcher refreshes the index on an external edit and purges a deleted file, stays off by default, and disposes cleanly with the fiber; the storage root resolves through `dshHomePath('memory')` and a configured `DSH_HOME` relocates memory with no other change; disposal removes the plugin's registrations and tools. New source directories hold per-file 100% coverage, and the README documents model, token, and KV-cache effects in the canonical Model Experience format, including the FTS-only default's zero embedding cost.

## Alternatives considered

- **Rely on `tool-session-query` alone** — rejected: it searches raw transcripts with no curation, hierarchy, priority, or injection; the model must know what to search and re-derive knowledge from logs every session.
- **Rely on third-party MCP memory servers** — rejected: the [third-party-memory-mcp-examples](../../implemented/feature/2026-07-31-third-party-memory-mcp-examples.md) decision explicitly keeps account, model, embedding, storage, and curation upstream; a product-owned knowledge layer needs first-party semantics and an off-by-default embedded default.
- **Vector-first search, embeddings default-on** — rejected: DeepSeek exposes no embeddings endpoint, so hybrid cannot be the default; FTS-only as the keyless, dependency-free floor is the honest default, with no vector path planned.
- **Full session logs into memory** — rejected: the transcript already lives in the session log and is reachable via `session_query`; duplicating it pollutes curated knowledge with noise and unbounded growth.
- **Model-authored arbitrary memory files** — rejected: unbounded write authority risks a model littering the home with ad-hoc files; `memory_set` writes stay scoped to the two evergreen paths (`MEMORY.md`, `workspace/MEMORY.md`), and session archives are written only by the plugin's own session-end path.
- **Memory as a session-log projection** — rejected: cross-session survival requires durable files outside any one session's log, and markdown is human-editable while the log is append-only.
- **In-memory-only recall (no on-disk store)** — rejected: memory must survive process restarts and be externally editable; on-disk markdown plus an index is the smallest durable form.
- **Reuse `recallable-compaction`'s checkpoint machinery for memory** — rejected for the cross-session store: that design's index checkpoints are frozen log stubs scoped to a live session, whereas memory is curated, editable, and decays. The two are complementary; the session-archive card borrows the compact form without importing the machinery.