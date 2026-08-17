# @deepseek-ai/dsh-tool-memory

[English](README.md) | 中文

**面向模型的记忆 Consumer**：在 `ctx.tools` 上注册 `memory_search`、`memory_get` 与 `memory_set`，贡献一段指明读取工具的静态系统提示词片段，并在每次会话开始注入最多 `maxInjectedChunks` 个常青分块作为 "Project memory" 快照。它是策展记忆 seam 的 Consumer；服务契约在 [`@deepseek-ai/dsh-memory`](../memory)，存储后端在 [`@deepseek-ai/dsh-memory-markdown`](../memory-markdown)。

## 工具

| 工具 | 操作 |
|---|---|
| `memory_search` | 检索策展的跨会话记忆，并以紧凑卡片（来源、分数、路径、摘要）返回最强的匹配知识分块。可选 `scope` 限定一个记忆作用域；可选 `limit` 限制命中数（默认为部署配置）。 |
| `memory_get` | 完整读取一个记忆文件，例如 `MEMORY.md` 或某个会话归档。 |
| `memory_set` | 以完整 markdown 内容写入一个记忆文件，替换已有内容。 |

记忆路径被解析并校验：裸 `MEMORY.md` 解析为全局文件，`workspace/MEMORY.md` 解析为工作区文件，`sessions/…` 解析为会话归档。任何其他路径以 `MEMORY_INVALID_PATH` 拒绝，从而保持模型写入权限狭窄。这些工具要求调用方绑定智能体；否则执行以 `MEMORY_TOOL_MISSING_AGENT` 拒绝。带类型的记忆失败以其自身的机器可路由代码呈现。

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `maxSearchResults` | `10` | 单次 `memory_search` 调用返回的最大命中数。 |
| `maxInjectedChunks` | `5` | 会话开始注入的常青分块数。 |

## 会话开始注入

插件监听每个会话第 1 步的 `agent/pre-step`。当 `ctx.memory.inject()` 返回常青分块时，它追加一条用户角色消息，以紧凑知识卡片渲染这些分块，消息来源为 `plugin`，section 名为 `Project memory`。注入是尽力而为的：provider 失败会被记录日志，会话在无快照的情况下继续。

```text
Project memory:
- [1] (global, MEMORY.md) # Deployment convention
- [2] (workspace, workspace/MEMORY.md) # Project layout
```

## Model Experience

### 记忆工具

#### What the model sees

三个用于持久、策展的跨会话知识的工具。`memory_search` 返回有序知识卡片；`memory_get` 返回完整文件；`memory_set` 成功时返回 `wrote memory to <path>`。静态系统提示词片段告诉模型策展的项目知识跨会话持久存在，以及应使用哪个工具来查找、读取和写入它。

#### Token effect

检索结果受 `maxSearchResults` 命中数上限约束，每条受摘要上限约束。`memory_get` 返回完整请求文件。`memory_set` 返回一行确认；写入的内容被建立索引，但不会被回显到上下文。会话开始注入在首个请求中增加最多 `maxInjectedChunks` 行知识卡片。

#### KV Cache effect

注入落在每个会话的首个请求中，加入其可复用前缀。工具结果是跟随前缀的一次性调用内容，不会使现有缓存条目失效。

### 注入快照

#### What the model sees

会话开始时一条以 `Project memory:` 开头的用户角色消息，列出最多 `maxInjectedChunks` 行知识卡片，每行显示分块的来源、路径与第一行实质内容。

#### Token effect

首个请求中最多 `maxInjectedChunks` 行卡片；除非模型显式召回记忆，否则后续请求没有。

#### KV Cache effect

快照只写入首个请求的前缀一次。后续请求原样复用该前缀。

## Known Limitations and Deferred Work

- **注入是尽力而为且仅限第 1 步**——provider 失败会被记录日志，会话在无快照的情况下继续，且记忆绝不会注入到恢复会话的中间步骤。未来工作可能将记忆呈现到后续回合或按显式请求呈现。
- **会话归档只能通过精确名称经 `memory_get` 读取**——`memory_set` 仅接受 `MEMORY.md` 与 `workspace/MEMORY.md`；归档由其他会话机制创建，而非本 Consumer。