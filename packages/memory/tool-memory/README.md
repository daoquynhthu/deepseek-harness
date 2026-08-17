# @deepseek-ai/dsh-tool-memory

English | [中文](README.zh.md)

The **model-facing memory Consumer**: registers `memory_search`, `memory_get`, and `memory_set` on `ctx.tools`, contributes a static system-prompt section naming the read tools, and injects up to `maxInjectedChunks` top evergreen chunks into each session start as a "Project memory" snapshot. It is the consumer of the curated-memory seam; the service contract lives in [`@deepseek-ai/dsh-memory`](../memory) and the storage backend in [`@deepseek-ai/dsh-memory-markdown`](../memory-markdown).

## Tools

| Tool | Operation |
|---|---|
| `memory_search` | Search curated cross-session memory and return the strongest matching knowledge chunks as compact cards (source, score, path, snippet). Optional `scope` restricts one memory scope; optional `limit` caps hits (defaults to the deployment configuration). |
| `memory_get` | Read one memory file completely, for example `MEMORY.md` or a specific session archive. |
| `memory_set` | Write one memory file with full markdown content, replacing any existing content. |

Memory paths are parsed and validated: bare `MEMORY.md` resolves to the global file, `workspace/MEMORY.md` to the workspace file, and `sessions/…` to a session archive. Any other path is rejected with `MEMORY_INVALID_PATH`, keeping model write authority narrow. The tools require an agent-bound caller; without one, execution rejects with `MEMORY_TOOL_MISSING_AGENT`. A typed memory failure is surfaced under its own machine-routable code.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `maxSearchResults` | `10` | Maximum hits returned by one `memory_search` call. |
| `maxInjectedChunks` | `5` | Number of top evergreen chunks injected at session start. |

## Session-start injection

The plugin listens on `agent/pre-step` for step 1 of each session. When `ctx.memory.inject()` returns evergreen chunks, it appends a user-role message rendering them as compact knowledge cards under a `plugin` message source with section name `Project memory`. Injection is best-effort: a provider failure is logged and the session continues without the snapshot.

```text
Project memory:
- [1] (global, MEMORY.md) # Deployment convention
- [2] (workspace, workspace/MEMORY.md) # Project layout
```

## Model Experience

### Memory tools

#### What the model sees

Three tools for durable, curated cross-session knowledge. `memory_search` returns ranked knowledge cards; `memory_get` returns a full file; `memory_set` returns `wrote memory to <path>` on success. The static system-prompt section tells the model that curated project knowledge persists across sessions and which tool to use for finding, reading, and writing it.

#### Token effect

Search results are capped at `maxSearchResults` hits, each bounded by the snippet limit. `memory_get` returns the full requested file. `memory_set` returns a one-line acknowledgment; the written content is indexed but not echoed back into context. Session-start injection adds up to `maxInjectedChunks` one-line knowledge cards to the first request.

#### KV Cache effect

Injection lands in the first request of each session, joining its reusable prefix. Tool results are per-call content that follows the prefix and does not invalidate existing cache entries.

### Injection snapshot

#### What the model sees

One user-role message at session start opening with `Project memory:` and listing up to `maxInjectedChunks` one-line knowledge cards, each showing the chunk's scope, path, and first substantive line.

#### Token effect

At most `maxInjectedChunks` one-line cards in the first request; none in later requests unless the model recalls memory explicitly.

#### KV Cache effect

The snapshot is written once into the first request's prefix. Later requests reuse that prefix unchanged.

## Known Limitations and Deferred Work

- **Injection is best-effort and step-1 only** — a provider failure is logged and the session continues without a snapshot, and memory is never injected into a resumed mid-session step. Future work may surface memory into later turns or on explicit request.
- **Session archives are write-reachable through `memory_get` only by exact name** — `memory_set` accepts only `MEMORY.md` and `workspace/MEMORY.md`; archives are created by other session machinery, not by this consumer.