# Agent Note: 跨会话记忆 — 策展知识持久化与混合召回

Status: implemented

[English](2026-08-16-cross-session-memory.md) | 中文

## 问题

只读自己会话日志的 agent 在每个全新会话里都从零开始。开发者会跨数周、跨多次会话继续一个项目：约定、决策、依赖事实、项目结构散落在之前 `session_query` 可达的日志里，但没有任何东西策展它们、在会话开始时浮出它们、区分"之前发生了什么"与"这个项目是什么"。模型必须从原始 transcript 重新推导持久事实，或靠提问重新学习。

现有 seam 不覆盖这一缺口。`session_query`（及其 `tool-session-query` consumer）检索的是原始会话事件：对对话记录的全文搜索，没有策展、没有层级、没有优先级。它是 transcript，不是知识。第三方记忆 MCP 服务器（[third-party-memory-mcp-examples](../../implemented/feature/2026-07-31-third-party-memory-mcp-examples.md) 边界）把存储、策展、模型、嵌入都推给上游，明确不在产品范围。`recallable-compaction`（会话内召回）是互补的，但限定于一个活跃会话的 shadowed spans，不是跨会话知识。此前没有任何东西交付产品自有的、跨会话的知识层。

Grok 的记忆系统（`xai-grok-memory`）是成熟参照：`~/.grok/memory/` 下的 markdown 存储，含全局与每工作区 `MEMORY.md` 及归档会话日志；SQLite 索引，含 FTS5 关键词搜索与可选向量 KNN；带时间衰减与源权重的混合评分；会话开始的初始注入加模型可用的搜索工具；监听外部编辑的文件 watcher；后台 dream 整合。DSH 已具备所需的 SQLite、工具与注入管道；此前唯独缺记忆层本身。

## 决定

DSH 以新 seam 交付跨会话记忆能力：Service Definition `@deepseek-ai/dsh-memory`、markdown provider `@deepseek-ai/dsh-memory-markdown`、模型可用 consumer `@deepseek-ai/dsh-tool-memory`。该能力把策展知识以可编辑 markdown 存入 harness home，为其建立索引以支持混合召回，把相关记忆注入会话开始，并向模型暴露搜索、读取与写入工具。

### 存储布局

```
{dshHome}/memory/
  MEMORY.md                              # global curated knowledge
  {workspace_hash}/                      # per-workspace, blake2b512(cwd) truncated
    MEMORY.md                            # project-level curated knowledge
    sessions/YYYY-MM-DD-{slug}-{sid8}.md # archived session summaries
    index.sqlite                         # chunk index: FTS5 keyword search
```

根目录经 `@deepseek-ai/dsh-home-paths` 的 `dshHomePath('memory')` 解析，保持 harness 的单根规则（`~/.dsh`，可用 `DSH_HOME` 覆盖）。工作区目录名是工作区路径的截断 blake2b512 哈希，遵循 `session-reference` 模式的不透明 id 约定：不明文存储任何工作区路径，同一项目的两个 checkout 共享同一份记忆。

三个 scope 沿用 grok：`global`（evergreen，所有工作区）、`workspace`（evergreen，一个项目）、`session`（自动归档的会话日志，衰减）。Evergreen 源豁免时间衰减；会话 chunk 按配置的半衰期衰减。

### 索引与混合搜索

`index.sqlite` 含 `chunks` 表（相对品牌 path、起止行、text、hash、source、访问次数、时间戳）与 contentless FTS5 虚拟表（BM25 关键词搜索）。搜索流水线沿用 grok 的关键词侧：FTS 关键词搜索始终可用；分数归一化到 `[0,1]`；先过滤内容空 chunk（空的或 scaffold 模板 `MEMORY.md` stub），在 `maxResults * candidateMultiplier` 的候选窗口上进行，使脚手架不会在结果上限内挤掉真实匹配；仅对会话 chunk 施加时间衰减；加源权重与访问频次提升；按 `maxResults` 封顶。关键词提取先用 `Intl.Segmenter`（ICU 词典）将汉字段预分词为词，使中文与英文走同一条 FTS 关键词路径，移除 grok 扩展的英文停用词集外加一组精心整理的中文停用词，丢弃单字符与纯数字词元，并保留带下划线的标识符。已发布 provider 是纯 FTS-only，无 embedding 或向量路径：召回路径永不依赖 LLM 或 embedding 调用，保持 keyless 回放确定性（与 `recallable-compaction` 排除语义召回是同一约束）。

### 初始注入

会话开始时，记忆插件查询会话工作区的索引，把最多 `maxInjectedChunks` 条高分的 evergreen 记忆作为紧凑的"项目记忆"段落注入系统提示，与现有 `agent-instructions` context 并列。注入走同一 FTS 搜索路径，因此继承评分、衰减与内容空过滤。`minScore` 阈值排除无关噪声。提示段落是静态字符串，点名 `memory_search` 与 `memory_get` 工具；注入的 chunk 渲染为可读知识卡片，而非原始事件 transcript。

注入每会话仅一次，而非每轮一次：插件在会话事件流中标记已注入的快照，后续轮次原样复用此前缀。这使请求头跨轮次字节稳定，保持 KV 缓存前缀复用；注入绝不会在会话中途重排或重过滤 chunk 而移动前缀。

### 模型可用工具

`@deepseek-ai/dsh-tool-memory` 注册三个工具，镜像 `tool-session-query` 的拆分（输入校验、服务边界、呈现）：

- `memory_search(query, scope?, limit?)` — 对策展记忆 chunk 的混合搜索；返回带 source、path 与覆盖元数据的 snippet。scope 过滤 global/workspace/session。
- `memory_get(path)` — 精确读取一个记忆文件的当前内容（如 `MEMORY.md` 或某个会话归档），用于命中后的跟进。
- `memory_set(path, content)` — 把策展知识追加到 evergreen `MEMORY.md` 路径，随后重建索引。

搜索与读取以类型化错误拒绝非 agent 调用者与从未存在的路径，都渲染普通 `tool/result`，使召回可从会话日志重建。工具 schema 与提示段落是静态字符串。

搜索工具暴露的是既有知识而非执行搜索的操作，与 `session_search` 完全一致。与 `tool-session-query` 的边界是刻意的：该包搜索原始会话事件；本包搜索策展知识。模型需要"上周二我们说了什么"用 `session_search`；需要"这个项目的约定是什么"用 `memory_search`。

### 写入路径

两条写入路径喂养索引：

1. **策展写入**：`memory_set(path, content)` 让用户或模型把策展知识追加到 `MEMORY.md`。写入是经存储层的 markdown 编辑，随后重建索引。`memory_set` 只接受 evergreen 路径（`MEMORY.md`、`workspace/MEMORY.md`），拒绝会话归档，使写边界比读表面更窄。这是主路径，也是让记忆可信的路径——模型写持久结论，而非原始 transcript。
2. **会话归档**：在每次会话 flush——会话存储持久化日志前已 await 的持久 checkpoint——插件把有界 what-happened 卡片写入 `sessions/YYYY-MM-DD-{slug}-{sid8}.md`，当会话足够充实（至少三条真实用户查询、合计至少 50 字节，排除插件与 goal 注入源）且非 subagent 时，使会话级历史可搜索而不污染策展知识。会话归档格式借用 `recallable-compaction` 的 frozen-index-chunk 思路：紧凑的卡片，而非完整 transcript（完整 transcript 已存在于会话日志）。归档挂在 flush checkpoint 而非会话销毁，因为 provider 的 `session/disposed` 监听器在 root dispose 时会先于会话分离被拆除（provider fiber 在 root 的销毁序中先卸载），这曾确定性丢失归档；flush 被存储 await，写入在 checkpoint 处持久。同一会话的后续 flush 会重写同一文件名，卡片反映累积会话，最终 flush 留下完整摘要供后续进程检索。文件名是确定性的：日期来自会话创建时间，slug 来自首条真实用户查询，sid8 是会话 id 的 blake2b512 摘要前 8 位十六进制（原始会话 id 形如 `session-N`，会违反归档名的 `[a-z0-9]{8}` 后缀）。卡片沿用 grok 的 `generate_metadata_summary`：消息计数、会话日期、前几条真实用户查询。

文件 watcher 为可选项：启用 `watcher.enabled` 后，provider 用原生文件系统事件监视布局根目录（原生监视不可用时回退到按 `watcher.pollIntervalMs` 周期轮询），并在记忆文件在 provider 之外被修改或消失时刷新索引；索引写入等非 markdown 事件被忽略，因此 provider 从不自我触发。默认关闭，外部对 `MEMORY.md` 的编辑仍在下一次索引打开与 `write` 重建索引时可见；memory-markdown README 记录该开关。

归档保留期为可选项：设置 `session.retentionDays` 后，provider 删除会话日期（文件名 `YYYY-MM-DD` 前缀，UTC）早于该天数的会话归档，并在打开时与 watcher 刷新时同步删除文件、缓存项与索引行。Evergreen `MEMORY.md` 从不匹配归档名契约，因此剪除只触及会话摘要；transcript 仍在会话日志中，剪除不丢任何 transcript。

### Dream 整合

一个后台 LLM pass 镜像 grok 的 `autoDream`：设置 `dream.enabled`（默认关闭，因为它需要 `dsh-llm` 运行时与 provider）后，每次会话 flush 之后运行一趟 pass，把未整合的会话归档整合进策展工作区记忆。门限是最少新归档数（`minNewArchives`，默认 3）与距上次 pass 的最短间隔（`intervalHours`，默认 24）；两个门限同时满足时，pass 从最旧归档开始选择，最多 `maxArchivesPerPass`（默认 10）个，把它们的卡片加当前工作区 `MEMORY.md` 组装进系统提示词，流式完成一次模型补全（配置的 `provider`/`model` 对，省略时回退到请求头里会话的路由对），并把 `## Dream consolidation — {date}` 一节追加到 `workspace/MEMORY.md`，文件不存在时以 `# Workspace memory` 头部创建。成功时把已整合归档名与运行时间记入 SQLite `meta` 表；失败或空补全不追加任何内容，失败补全保持归档未整合以便下一趟重试。该 pass 尽力而为：并发触发会合并，llm 运行时或路由不可用时静默跳过，且从不触碰会话日志，因此回放的 transcript 不变。`memory/dream` 会话事件记录路由、归档与渲染的提示词和输出以便重建。

### 配置

所有旋钮都在各包的 `Config` 中，加载时校验：

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

部署性选择是校验过的 `Config` 字段，遵循 no-hardcoded-tunables 规则；唯一固定值是协议不变量与 DSH 专属的 `DSH_HOME` 解析。

### 打包

- `@deepseek-ai/dsh-memory` — Service Definition，`ctx.memory`，导出 `MemoryService` 接口（search、read、write、inject）、分块与评分辅助、类型图。按包惯例默认导出 service 类。
- `@deepseek-ai/dsh-memory-markdown` — provider：markdown 存储、SQLite 索引（复用 harness 的 `session-persistence-sqlite` sqlite 约定）、FTS5、会话归档器，以及基于 `dsh-llm` 运行时的可选 dream 整合 pass。
- `@deepseek-ai/dsh-tool-memory` — Consumer：`memory_search`、`memory_get`、`memory_set` 工具加提示段落。

seam 遵循 [capability-seam pattern](../../implemented/architecture/2026-06-13-capability-seams.md)：Definition、Provider、Consumer 角色各自存在，无角色缺失。服务经 `ctx.effect()` 注册，带 HMR 安全销毁。

### 后续

留待观察再决定：

- **向量 KNN 与混合评分不做**：项目不发布 embeddings 端点，因此向量检索、`textWeight`/`vectorWeight`/`mmrEnabled` 式旋钮与语义搜索默认化永久不在范围。已发布 provider 保持纯 FTS-only、零 LLM 或 embedding 调用。
- **跨设备同步**：记忆位于 harness home 下且无同步；观察到需求时，加同步层而不动 provider。保留 GC 已作为可选的 `session.retentionDays` 发布（打开时与 watcher 刷新时对会话归档做 max-age 修剪）。

## 后果

- **FTS-only 的语义召回代价**：FTS 地板会漏掉向量搜索能捕获的语义匹配。它换来 keyless、零依赖、确定性的召回路径，零 LLM 或 embedding 成本、字节稳定的回放。DeepSeek 公开 API 无 embeddings 端点（V4-Pro/V4-Flash 仅 chat），且项目不发布 embeddings 端点，因此向量检索不在范围而非延后选项。
- **策展依赖**：记忆质量依赖模型经 `memory_set` 写持久结论；未经训练的模型可能写得少或写得滥。会话归档与注入给出地板；训练侧的后续（与 `recallable-compaction` 相同动态）留待观察。
- **上下文税**：注入 chunk 占据每个会话开始的请求 token。`maxInjectedChunks`/`minScore` 旋钮约束它，默认很小。
- **可编辑存储漂移**：用户编辑 `MEMORY.md` 可能引入不一致；内容空过滤约束搜索侧效应，策展本身就是特性而非 bug。
- **双搜索 seam**：`tool-session-query` 与 `tool-memory` 都触及过去工作；边界（transcript vs 知识）在两份提示段落里都有文档，发布示例保持两者 opt-in。

## 验证

keyless headless 示例端到端覆盖完整闭环：某会话经 `memory_set` 写入策展记忆，新会话的请求头显示注入的"项目记忆"段落，新会话里的 `memory_search` 工具调用检索到所写 chunk。带记忆注入与工具召回的会话满足 request-reconstruction 不变量。

快照与包测试钉住其余行为：`memory_search` 找到仅存在于策展记忆（而非当前会话日志）中的内容并带 source、path 与覆盖元数据，`memory_get` 精确读文件；一个双语关键词召回快照验证跨新会话中文与英文词条走同一条 FTS 路径检索；两者都以类型化错误拒绝非 agent 调用者与从未存在的路径；工具 schema 与提示段落跨 pass 字节一致；无 embedding 配置时每次注入与搜索都是 FTS-only、零 LLM 或 embedding 调用；注入每会话仅一次且注入后的请求头跨后续轮次字节稳定（KV 缓存前缀复用）；evergreen chunk 豁免时间衰减、会话 chunk 按配置半衰期衰减、重建索引时不变内容保留 chunk 创建时间戳、内容空 scaffold chunk 永不进入结果或注入；搜索结果携带与 `memory_get` 接受的相同相对品牌路径；一个充实的会话在其 flush 时归档到确定性的 `sessions/YYYY-MM-DD-{slug}-{sid8}.md`（创建时间日期、slug、id 摘要），后续 flush 重写，可被新进程召回，`saveOnEnd: false` 不写任何文件；`session.retentionDays` 在打开时剪除早于配置窗口的归档并保留 evergreen `MEMORY.md`，省略则保留归档；dream pass 把未整合归档从最旧开始整合进工作区记忆并带 `memory/dream` 事件，尊重最少数量与间隔门限、记录消耗以便重复趟跳过、回退到会话的路由对、合并并发趟、模型调用失败时保持归档未整合，而 disabled、无 llm、无路由与 never-open 路径跳过；可选 watcher 在外部编辑时刷新索引、删除文件时清理索引、默认关闭、随 fiber 干净销毁；存储根经 `dshHomePath('memory')` 解析，配置 `DSH_HOME` 无需其他改动即可重定位记忆；销毁移除插件的注册与工具。新源码目录保持每文件 100% 覆盖，README 以规范 Model Experience 格式记录 model、token、KV-cache 效应，包括 FTS-only 默认的零 embedding 成本。

## 备选方案

- **仅依赖 `tool-session-query`** — 否决：它搜索的是无策展、无层级、无优先级、无注入的原始 transcript；模型必须知道搜什么并每会话从日志重推知识。
- **依赖第三方 MCP 记忆服务器** — 否决：[third-party-memory-mcp-examples](../../implemented/feature/2026-07-31-third-party-memory-mcp-examples.md) 决策明确把 account、model、embedding、storage、策展留在上游；产品自有的知识层需要一方语义和默认关闭的内嵌默认。
- **向量优先搜索、embedding 默认开** — 否决：DeepSeek 无 embeddings 端点，因此 hybrid 不能是默认；FTS-only 作为 keyless、零依赖的地板才是诚实默认，且无向量路径计划。
- **把完整会话日志放进记忆** — 否决：transcript 已在会话日志中且可经 `session_query` 到达；重复它会以噪声与无界增长污染策展知识。
- **模型可写任意记忆文件** — 否决：无界写权限有模型往 home 撒临时文件的风险；`memory_set` 写入限定到两个 evergreen 路径（`MEMORY.md`、`workspace/MEMORY.md`），会话归档仅由插件自身的会话结束路径写入。
- **把记忆做成会话日志投影** — 否决：跨会话存活需要任一单会话日志之外的持久文件，且 markdown 可人工编辑而日志是 append-only。
- **仅内存召回（无磁盘存储）** — 否决：记忆必须跨进程重启存活且可外部编辑；磁盘 markdown 加索引是最小的持久形态。
- **把 `recallable-compaction` 的 checkpoint 机制复用于记忆** — 否决跨会话存储：该设计的 index checkpoints 是限定于活跃会话的冻结日志 stub，而记忆是策展、可编辑、会衰减的。二者互补；会话归档卡片借用其紧凑形态而不引入其机制。