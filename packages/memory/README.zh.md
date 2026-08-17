# memory/：跨会话策展知识能力家族

[English](README.md) | 中文

本家族提供跨会话持久化的策展知识：模型写入记忆文件，harness 建立索引，检索与自动注入把正确的知识带回到后续会话——独立于原始会话日志。

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`memory/`](memory/README.md) | 定义记忆服务契约、检索流水线与记忆路径 | `ctx.memory` |
| [`memory-markdown/`](memory-markdown/README.md) | 以可编辑 markdown 文件实现记忆，并用 SQLite 混合检索建立索引 | `ctx.memory` |
| [`tool-memory/`](tool-memory/README.md) | 公开 `memory_search`/`memory_get`/`memory_set` 工具，并在会话开始注入最高分块 | 注册到 `ctx.tools` |

设计与验收标准见提案笔记 [cross-session-memory](../../.agents/notes/proposed/feature/2026-08-16-cross-session-memory.md)。