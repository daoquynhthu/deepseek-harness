# @deepseek-ai/dsh-memory

[English](README.md) | 中文

**策展记忆 Service Definition**：一个后端无关的 `ctx.memory` 服务，用于存储和召回智能体选择跨会话记住的知识。检索、读取、写入、列出、分块读取与会话开始注入是具体的抽象契约；后端负责提供存储、索引与召回。配套后端是 [`@deepseek-ai/dsh-memory-markdown`](../memory-markdown)，面向模型的 Consumer 是 [`@deepseek-ai/dsh-tool-memory`](../tool-memory)。

本包定义服务、记忆路径与分块词汇，以及所有后端共享的评分管线。它不持有任何存储。

## 服务 API

`MemoryService`（`ctx.memory`）具有以下操作：

| 成员 | 语义 |
|---|---|
| `search(request)` | 运行配置的混合检索管线，并返回带每条结果的召回模式与覆盖元数据的有序结果。可选的 `scope`、`limit` 与 `minScore` 覆盖服务配置；`signal` 取消。 |
| `read(path)` | 返回一个记忆文件的当前内容。文件不存在时以 `MEMORY_FILE_NOT_FOUND` 拒绝。 |
| `write(path, content)` | 原子地替换一个记忆文件的内容。 |
| `list()` | 返回已知记忆文件及其大小与修改元数据，按确定性顺序排列。 |
| `readChunks(path)` | 返回一个记忆文件的当前分块，从持久状态刷新。 |
| `inject(request)` | 返回用于会话开始注入的常青分块，排除无内容分块。 |

## 记忆路径

`MemoryPath` 是一个[带品牌类型](../../../docs/subsystems/core.md#branded-ids)的标识，其字符串编码作用域根，因此不透明句柄在存储与索引行之间保持自描述：

| 路径 | 作用域 | 位置 |
|---|---|---|
| `MEMORY.md` | `global` | 宿主主目录记忆根 |
| `workspace/MEMORY.md` | `workspace` | 工作区哈希目录 |
| `sessions/YYYY-MM-DD-{slug}-{sid8}.md` | `session` | 工作区哈希 `sessions/` 目录 |

路径工厂拒绝任何其他路径，从而保持模型写入权限狭窄。完整词汇见[记忆子系统页](../../../docs/subsystems/memory.md)。

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `maxResults` | `10` | 单次检索返回的最大结果数。 |
| `minScore` | `0.1` | 最低接受分数；更低分块被丢弃。 |
| `textWeight` | `1` | 合并分数中的 FTS 关键词权重。 |
| `vectorWeight` | `1` | 合并分数中的向量相似度权重；仅在仅 FTS 模式下不使用。 |
| `mmrEnabled` | `false` | 启用时应用 MMR 多样性重排。 |
| `temporalDecayEnabled` | `true` | 启用时对 `session` 分块应用指数衰减。 |
| `halfLifeDays` | `30` | 半衰期（天）；`lambda = ln(2) / halfLifeDays`。 |
| `sourceWeights` | `{ global: 1, workspace: 1, session: 1 }` | 各作用域分数权重。 |

## 评分管线

合并分数由 FTS 位置基数经共享的 `scoring.ts` 助手计算：常青作用域（`global`、`workspace`）保留基础分数，`session` 分块按配置的半衰期随年龄指数衰减，各作用域权重缩放结果，访问频率加成（封顶 0.2）奖励出现在召回中的分块。分数被限制在 `[0, 1]`。无内容分块——结构性为空或常青样板脚手架——绝不会出现在结果或注入中。

## 错误

带类型的 `MemoryError` 失败携带稳定的机器可路由代码：

| 代码 | 含义 |
|---|---|
| `MEMORY_INVALID_CONFIG` | 配置或请求边界无效。 |
| `MEMORY_FILE_NOT_FOUND` | 寻址的记忆文件不存在。 |
| `MEMORY_INVALID_PATH` | 该路径不是允许的记忆路径。 |
| `MEMORY_ABORTED` | 请求已中止。 |

## Model Experience

### 记忆注入与召回

#### What the model sees

模型看到的是 Consumer 的工具与注入返回的结果、文件与分块——本包自身不贡献任何面向模型的文本。`memory_search` 返回带作用域、分数与路径的有序知识卡片；`memory_get` 返回完整文件；`memory_set` 返回写入确认。会话开始注入以 "Project memory" 快照呈现常青分块。

#### Token effect

注入在会话开始增加最多 `maxInjectedChunks` 条分块标题；检索结果受 `maxResults` 限制，每条摘要设上限。写入的记忆建立索引，但在被召回前不会重新发送给模型。

#### KV Cache effect

注入发生在会话开始、模型的第一个回合之前，因此加入可复用的请求前缀。检索与读取结果是一次性调用内容，跟随前缀且不会使现有缓存条目失效。

## Known Limitations and Deferred Work

- **服务是后端无关的，但现装后端默认仅 FTS**——`dsh-memory-markdown` 中的混合向量召回是可选开启的，且需要 embedding provider；没有它时，每次检索都是 `fts-only`，零 LLM 或 embedding 调用。
- **无整合或遗忘**——记忆通过显式的 `memory_set` 写入与检索驱动的访问次数来策展；没有后台 "dream" 整理、文件监视器或从会话归档的自动提升。