# memory/ — cross-session curated knowledge capability family

English | [中文](README.zh.md)

This family provides durable, curated knowledge that persists across sessions: the model writes memory files, the harness indexes them, and search plus automatic injection surface the right knowledge back into later sessions — independently of raw session logs.

| Package | Role | ctx key |
|---|---|---|
| [`memory/`](memory/README.md) | Defines the memory service contract, search pipeline, and memory paths | `ctx.memory` |
| [`memory-markdown/`](memory-markdown/README.md) | Implements memory as editable markdown files indexed with SQLite keyword recall | `ctx.memory` |
| [`tool-memory/`](tool-memory/README.md) | Exposes `memory_search`/`memory_get`/`memory_set` tools and injects top chunks at session start | registers on `ctx.tools` |

The design and acceptance criteria live in the proposal note [cross-session-memory](../../.agents/notes/proposed/feature/2026-08-16-cross-session-memory.md).