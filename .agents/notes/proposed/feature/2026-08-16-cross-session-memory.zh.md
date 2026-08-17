# Agent Note: 跨会话记忆 — 策展知识持久化与混合召回

Status: proposed

[English](2026-08-16-cross-session-memory.md) | 中文

## 问题

只读自己会话日志的 agent 在每个全新会话里都从零开始。开发者会跨数周、跨多次会话继续一个项目：约定、决策、依赖事实、项目结构散落在之前 `session_query` 可达的日志里，但没有任何东西策展它们、在会话开始时浮出它们、区分"之前发生了什么"与"这个项目是什么"。模型必须从原始 transcript 重新推导持久事实，或靠提问重新学习。

现有 seam 不覆盖这一缺口。`session_query`（及其 `tool-session-query` consumer）检索的是原始会话事件：对对话记录的全文搜索，没有策展、没有层级、没有优先级。它是 transcript，不是知识。第三方记忆 MCP 服务器（[third-party-memory-mcp-examples](../../implemented/feature/2026-07-31-third-party-memory-mcp-examples.md) 边界）把存储、策展、模型、嵌入都推给上游，明确不在产品范围。`recallable-compaction`（会话内召回）是已提议且互补的，但它限定于一个活跃会话的 shadowed spans，不是跨会话知识。没有任何东西提供一个产品自有的、跨会话的知识层。

Grok 的记忆系统（`xai-grok-memory`）是成熟参照：`~/.grok/memory/` 下的 markdown 存储，含全局与每工作区 `MEMORY.md` 及归档会话日志；SQLite 索引，含 FTS5 关键词搜索与可选向量 KNN；带时间衰减与源权重的混合评分；会话开始的初始注入加模型可用的搜索工具；监听外部编辑的文件 watcher；后台 dream 整合。DSH 已具备所需的 SQLite、工具与注入管道；唯独缺记忆层本身。

## 提案

以新 seam 交付跨会话记忆能力：Service Definition `@deepseek-ai/dsh-memory`、markdown provider `@deepseek-ai/dsh-memory-markdown`、模型可用 consumer `@deepseek-ai/dsh-tool-memory`。该能力把策展知识以可编辑 markdown 存入 harness home，为其建立索引以支持混合召回，把相关记忆注入会话开始，并向模型暴露搜索与读取工具。

### 存储布局

```
{dshHome}/memory/
  MEMORY.md                              # global curated knowledge
  {workspace_hash}/                      # per-workspace, blake3(cwd) truncated
    MEMORY.md                            # project-level curated knowledge
    sessions/YYYY-MM-DD-{slug}-{sid8}.md # archived session summaries
    index.sqlite                         # chunk index: FTS5 + optional vec0
```

根目录经 `@deepseek-ai/dsh-home-paths` 的 `dshHomePath('memory')` 解析，保持 harness 的单根规则（`~/.dsh`，可用 `DSH_HOME` 覆盖）。工作区目录名是工作区路径的截断 blake3 哈希，遵循 `session-reference` 模式的不透明 id 约定：不明文存储任何工作区路径，同一项目的两个 checkout 共享同一份记忆。

三个 scope 沿用 grok：`global`（evergreen，所有工作区）、`workspace`（evergreen，一个项目）、`session`（自动归档的会话日志，衰减）。Evergreen 源豁免时间衰减；会话 chunk 按配置的半衰期衰减。

### 索引与混合搜索

`index.sqlite` 含 `chunks` 表（path、起止行、text、hash、source、访问次数、时间戳）、contentless FTS5 虚拟表（BM25 关键词搜索），以及——配置了 embedding provider 时——`vec0` 虚拟表（KNN）。搜索流水线是 grok 的：FTS 关键词搜索始终可用；有嵌入时合并向量 KNN；分数归一化到 `[0,1]`；过滤内容空 chunk（空的或 scaffold 模板 `MEMORY.md` stub）；仅对会话 chunk 施加时间衰减；加源权重与访问频次提升；可选 MMR 多样性重排；按 `maxResults` 封顶。优雅降级是承重设计：无 embedding provider 时模式为 FTS-only，`textWeight = 1.0`，召回路径永不依赖 LLM 或 embedding 调用，保持 keyless 回放确定性（与 `recallable-compaction` 排除语义召回是同一约束）。

embedding provider 可选，默认永不随产品发布。DeepSeek 公开 API 无 embeddings 端点（V4-Pro/V4-Flash 仅 chat），因此默认部署跑 FTS-only；配置了 OpenAI 兼容 embeddings 端点（provider 名、model、dimensions）的部署通过同一 `dsh-llm` family seam 获得混合搜索。这是配置而非代码：向量路径绝不能使 keyless FTS 路径回退。

### 初始注入

会话开始时，记忆插件查询会话工作区的索引，把最多 `maxInjectedChunks` 条高分的 evergreen 记忆作为紧凑的"项目记忆"段落注入系统提示，与现有 `agent-instructions` context 并列。注入走同一混合搜索路径，因此继承评分、衰减与内容空过滤。`minScore` 阈值排除无关噪声。提示段落是静态字符串，点名 `memory_search` 与 `memory_get` 工具；注入的 chunk 渲染为可读知识卡片，而非原始事件 transcript。

### 模型可用工具

`@deepseek-ai/dsh-tool-memory` 注册两个只读工具，镜像 `tool-session-query` 的拆分（输入校验、服务边界、呈现）：

- `memory_search(query, scope?, limit?)` — 对策展记忆 chunk 的混合搜索；返回带 source、path 与覆盖元数据的 snippet。scope 过滤 global/workspace/session。
- `memory_get(path)` — 精确读取一个记忆文件的当前内容（如 `MEMORY.md` 或某个会话归档），用于命中后的跟进。

两者都以类型化错误拒绝非 agent 调用者与从未存在的路径，都渲染普通 `tool/result`，使召回可从会话日志重建。工具 schema 与提示段落是静态字符串。

搜索工具暴露的是既有知识而非执行搜索的操作，与 `session_search` 完全一致。与 `tool-session-query` 的边界是刻意的：该包搜索原始会话事件；本包搜索策展知识。模型需要"上周二我们说了什么"用 `session_search`；需要"这个项目的约定是什么"用 `memory_search`。

### 写入路径

两条写入路径喂养索引：

1. **策展写入**：`memory_set(path, content)` 工具与显式 CLI/命令入口让用户或模型把策展知识追加到 `MEMORY.md`。写入是经存储层的 markdown 编辑，随后重建索引。这是主路径，也是让记忆可信的路径——模型写持久结论，而非原始 transcript。
2. **会话归档**：会话结束时（配置 `saveOnEnd`）插件把有界会话摘要写入 `sessions/YYYY-MM-DD-{slug}-{sid8}.md`，使会话级历史可搜索而不污染策展知识。会话归档格式借用 `recallable-compaction` 的 frozen-index-chunk 思路：紧凑的 what-happened 卡片，而非完整 transcript（完整 transcript 已存在于会话日志）。

watcher（可选，默认关）在搜索前对外部编辑的 `.md` 文件重建索引，沿用 grok 的 dirty-file 同步——用户在自己编辑器里改 `MEMORY.md` 后无需重启即可在召回中看到改动。删除的文件移除其 chunk。

### 配置

所有旋钮都在 `Config` 中，加载时校验：

```
memory:
  enabled: true
  root: ~               # default {dshHome}/memory
  injection:
    enabled: true
    maxInjectedChunks: 5
    minScore: 0.2
  search:
    maxResults: 10
    minScore: 0.1
    textWeight: 1.0
    vectorWeight: 1.0
    mmrEnabled: false
    temporalDecay:
      enabled: true
      halfLifeDays: 30
  embedding:            # optional; empty = FTS-only
    provider: ''
    model: ''
    dimensions: 0
  session:
    saveOnEnd: true
  watcher:
    enabled: false
```

部署性选择是校验过的 `Config` 字段，遵循 no-hardcoded-tunables 规则；唯一固定值是协议不变量与 DSH 专属的 `DSH_HOME` 解析。

### 打包

- `@deepseek-ai/dsh-memory` — Service Definition，`ctx.memory`，导出 `MemoryService` 接口（search、read、write、inject）、分块与评分辅助、类型图。按包惯例默认导出 service 类。
- `@deepseek-ai/dsh-memory-markdown` — provider：markdown 存储、SQLite 索引（复用 harness 的 `session-persistence-sqlite` sqlite 约定）、FTS5、可选 vec0、watcher、会话归档器。
- `@deepseek-ai/dsh-tool-memory` — Consumer：`memory_search`、`memory_get`、`memory_set` 工具加提示段落。
- 可选 `@deepseek-ai/dsh-memory-embedding-http` — 按 `dsh-llm` 约定的 OpenAI 兼容 embeddings provider，永不随默认发布。

seam 遵循 [capability-seam pattern](../../implemented/architecture/2026-06-13-capability-seams.md)：Definition、Provider、Consumer 角色各自存在，无角色缺失。服务经 `ctx.effect()` 注册，带 HMR 安全销毁。

### 后续

留待观察再决定：

- **Dream 整合**（grok 的 autoDream）：后台 LLM pass 把会话归档整合进策展工作区记忆，以时间与会话数为门——在观察到策展漂移或会话归档膨胀时。
- **MMR 默认开启**与按源权重调参——在观察到召回结果冗余时。
- **语义搜索成为默认**——需要一方 embeddings 端点；在那之前 embedding 保持可选配置。
- **跨设备同步与保留 GC**（会话归档的 max-age 修剪）——在观察到存储增长时。

## 备选方案

- **仅依赖 `tool-session-query`** — 否决：它搜索的是无策展、无层级、无优先级、无注入的原始 transcript；模型必须知道搜什么并每会话从日志重推知识。
- **依赖第三方 MCP 记忆服务器** — 否决：[third-party-memory-mcp-examples](../../implemented/feature/2026-07-31-third-party-memory-mcp-examples.md) 决策明确把 account、model、embedding、storage、策展留在上游；产品自有的知识层需要一方语义和默认关闭的内嵌默认。
- **向量优先搜索、embedding 默认开** — 否决：DeepSeek 无 embeddings 端点，因此 hybrid 不能是默认；FTS-only 作为 keyless、零依赖的地板才是诚实默认，向量是配置。
- **把完整会话日志放进记忆** — 否决：transcript 已在会话日志中且可经 `session_query` 到达；重复它会以噪声与无界增长污染策展知识。
- **模型可写任意记忆文件** — 否决：无界写权限有模型往 home 撒临时文件的风险；写入限定到已知路径（`MEMORY.md`、会话归档），以窄 `memory_set` 表面。
- **把记忆做成会话日志投影** — 否决：跨会话存活需要任一单会话日志之外的持久文件，且 markdown 可人工编辑而日志是 append-only。
- **仅内存召回（无磁盘存储）** — 否决：记忆必须跨进程重启存活且可外部编辑；磁盘 markdown 加索引是最小的持久形态。
- **把 `recallable-compaction` 的 checkpoint 机制复用于记忆** — 否决跨会话存储：该设计的 index checkpoints 是限定于活跃会话的冻结日志 stub，而记忆是策展、可编辑、会衰减的。二者互补；会话归档卡片借用其紧凑形态而不引入其机制。

## 验收标准

- 一个 keyless 真实可运行示例端到端覆盖完整闭环：某会话经 `memory_set` 写入策展记忆，新会话的请求头显示注入的"项目记忆"段落，新会话里的 `memory_search` 工具调用检索到所写 chunk。带记忆注入与工具召回的会话满足 request-reconstruction 不变量。
- `memory_search` 找到仅存在于策展记忆（而非当前会话日志）中的内容，带 source、path 与覆盖元数据；`memory_get` 精确读文件；两者都以类型化错误拒绝非 agent 调用者与从未存在的路径；工具 schema 与提示段落跨 pass 字节一致。
- 无 embedding 配置时，每次注入与搜索都用 FTS-only（`textWeight = 1.0`），零 LLM 或 embedding 调用——由 keyless 示例与包测试断言。
- Evergreen chunk（global/workspace）豁免时间衰减；会话 chunk 按配置半衰期衰减；内容空 scaffold chunk 永不进入结果或注入。
- 存储根经 `dshHomePath('memory')` 解析；配置 `DSH_HOME` 无需其他改动即可重定位记忆。
- 销毁移除插件的注册、工具与 watcher（HMR 安全测试）；`doc-sync` 目录在同一变更中更新；新源码目录保持每文件 100% 覆盖。
- 打包、配置与 seam JSDoc 点名全部三个角色；README 以规范 Model Experience 格式记录 model、token、KV-cache 效应，包括 FTS-only 默认的零 embedding 成本。

## 风险

- **无嵌入时的召回质量**：FTS-only 会漏掉向量搜索能捕获的语义匹配。地板是诚实的（模型今天已从日志重推），embedding 是对有此需求的部署的显式选择。
- **策展依赖**：记忆质量依赖模型经 `memory_set` 写持久结论；未经训练的模型可能写得少或写得滥。会话归档与注入给出地板；训练侧的后续（与 `recallable-compaction` 相同动态）留待观察。
- **上下文税**：注入 chunk 占据每个会话开始的请求 token。`maxInjectedChunks`/`minScore` 旋钮约束它，默认很小。
- **可编辑存储漂移**：用户编辑 `MEMORY.md` 可能引入不一致；watcher 与内容空过滤约束搜索侧效应，策展本身就是特性而非 bug。
- **双搜索 seam**：`tool-session-query` 与 `tool-memory` 都触及过去工作；边界（transcript vs 知识）在两份提示段落里都有文档，发布示例保持两者 opt-in。