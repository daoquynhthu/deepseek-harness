# @deepseek-ai/dsh-memory-markdown

[English](README.md) | 中文

**基于 markdown 的记忆 Service Provider**：在宿主主目录下的可编辑 markdown 文件之上实现 `ctx.memory`，并用 SQLite FTS5 为关键词检索建立索引。现装路径仅 FTS，零 LLM 或 embedding 调用；向量检索不在计划内。

本包持有策展记忆 seam 的存储、索引与召回。服务契约在 [`@deepseek-ai/dsh-memory`](../memory)；面向模型的 Consumer 是 [`@deepseek-ai/dsh-tool-memory`](../tool-memory)。

## 布局

记忆根通过宿主主目录解析（`{dshHome}/memory`，可用 `root` 覆盖）。工作区作用域文件位于由已解析工作区路径的稳定哈希派生的目录下，因此同一项目的两个检出共享一份记忆，而不存储明文工作区路径。

```
{dshHome}/memory/
  MEMORY.md                              # global curated knowledge
  {workspace_hash}/
    MEMORY.md                            # project-level curated knowledge
    sessions/YYYY-MM-DD-{slug}-{sid8}.md # archived session summaries
    index.sqlite                         # chunk index: FTS5 keyword search
```

索引数据库是一个专用 SQLite 文件，以属主权限（`0600`）创建。其 schema 版本与应用 id 防止无关数据库误用：无法识别的派生索引或外部应用 id 会响亮失败，而不是被静默重置。

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `index.maxChunkChars` | `800` | 最大分块字符数。 |
| `index.chunkOverlapChars` | `120` | 续分块之间的重叠字符数。 |
| `openAt` | `startup` | 在激活（`startup`）、首次检索（`first-search`）或 `never` 时打开 SQLite 索引。 |
| `journalMode` | `wal` | SQLite 日志模式（`wal`、`delete`、`truncate`、`persist`）。 |
| `root` | *（省略）* | 显式记忆根；默认为 `{dshHome}/memory`。 |
| `workspace` | *（必填）* | 用于派生工作区记忆目录的工作区路径。 |
| `dshHome` | *（省略）* | 显式宿主主目录覆盖。 |
| `path` | *（省略）* | 记忆索引数据库路径；默认为 `{root}/index.sqlite`。 |
| `session.saveOnEnd` | `true` | 把充实的会话归档到工作区会话目录。 |
| `session.retentionDays` | *（省略）* | 剪除会话日期早于该天数的会话归档；省略即关闭。 |
| `watcher.enabled` | `false` | 监视记忆目录并在外部编辑时刷新索引。 |
| `watcher.debounceMs` | `100` | 合并快速文件系统事件的毫秒数。 |
| `watcher.pollIntervalMs` | `5000` | 原生监视不可用时轮询探测的毫秒间隔。 |
| `dream.enabled` | `false` | 在后台 LLM 一趟中把会话归档整合进工作区记忆；需要 `dsh-llm` 运行时。 |
| `dream.intervalHours` | `24` | 两次 dream 一趟之间的最小小时数。 |
| `dream.minNewArchives` | `3` | 触发一趟所需的最少未整合会话归档数。 |
| `dream.maxArchivesPerPass` | `10` | 每趟最多整合的归档数，从最旧开始。 |
| `dream.maxTokens` | `1024` | 每趟的补全 token 上限。 |
| `dream.provider` / `dream.model` | *（省略）* | 一趟使用的 provider/model 对；省略时回退到会话的路由对。 |
| （服务键） | 见 `dsh-memory` | 继承自 Service Definition 的检索与评分配置。 |

`workspace` 是必填项，且不得为空。`openAt: never` 禁用检索与注入：调用以 `MEMORY_INVALID_CONFIG` 拒绝，并说明部署将索引配置为从不打开。`dream.provider` 与 `dream.model` 必须同时提供且非空；dream 可调参数必须是正整数安全整数。

## Dream consolidation

设置 `dream.enabled` 后，provider 会在每次会话 flush 后运行一趟后台 pass，把未整合的会话归档整合进工作区 `MEMORY.md`。只有当两个门限同时满足时该趟才会触发：至少 `minNewArchives` 个归档尚未整合，且距上次一趟至少过去了 `intervalHours` 小时（没有记录上次运行时间的一趟总会运行）。它从最旧的归档开始读取，最多 `maxArchivesPerPass` 个，用这些卡片加当前 `MEMORY.md` 组装系统提示词，经配置的 provider/model 对（省略时回退到会话的路由对）流式完成补全，并把 `## Dream consolidation — {date}` 一节追加到 `MEMORY.md`，文件不存在时以 `# Workspace memory` 头部创建。成功时一趟会把已整合的归档名与运行时间记入 SQLite `meta` 表，因此重复一趟会跳过它们。空补全是一次成功的、不追加任何内容的趟；失败的补全发出警告、不追加内容、并保持归档未整合以便下一趟重试。该趟尽力而为：并发触发会合并，缺少 `dsh-llm` 运行时或路由不可用时会跳过并警告，而不会让 flush 失败。`memory/dream` 会话事件记录路由、归档、渲染的提示词与输出以便重建。

## 会话归档

在每次会话 flush 时，provider 为通过归档门限的会话写摘要卡片：至少三条真实用户查询（排除插件与 goal 注入源）合计至少 50 字节，且来源非 `subagent`。卡片落在 `sessions/{date}-{slug}-{sid8}.md`，其中 `date` 是会话创建日期的 UTC 形式，`slug` 是首条真实用户查询小写并折叠为 `[a-z0-9-]`（截断到 30 字符，为空时用 `session`），`sid8` 是会话 id 的 `blake2b512` 摘要前 8 位十六进制——一个稳定的 id 派生后缀，保证文件名确定性而不泄露完整会话 id。卡片是 frozen-index-chunk 风格的 what-happened 摘要（消息计数、创建日期、前五条真实查询），绝非 transcript：transcript 已存在于会话日志。同一会话的后续 flush 重写同一文件名，因此卡片始终反映累积会话；退出前的最终 flush 把完整摘要留给下一个进程检索。`saveOnEnd: false` 完全禁用归档。

## 索引与召回

打开时，provider 扫描布局根目录并重新索引每个 `.md` 文件，删除磁盘上已不存在文件的索引行。设置 `session.retentionDays` 时，还会删除会话日期（文件名的 `YYYY-MM-DD` 前缀，UTC）早于该天数的会话归档，永久的 `MEMORY.md` 文件不受影响；transcript 已存在于会话日志，因此剪除归档不会丢失任何 transcript。每次写入都会重新索引该文件；内存状态在读取时惰性刷新。启用 `watcher.enabled` 后，provider 还会用原生文件系统事件监视布局根目录（原生监视不可用时回退到按 `watcher.pollIntervalMs` 周期轮询），并在记忆文件在 provider 之外被修改或消失时刷新索引；索引写入等非 markdown 事件被忽略，因此 provider 从不自我触发。分块文本以 contentless FTS5 表（`unicode61` 分词器）建立索引；汉字段在建立索引与查询提取前先用 `Intl.Segmenter` 预分词，因此中文与英文走同一条关键词路径。检索通过移除精心整理的中英文停用词集提取关键词，丢弃单字符与纯数字词元，同时保留有意义的短词与带下划线的标识符，在 `limit * candidateMultiplier` 行的候选窗口上运行带引号词条的 FTS5 扫描，丢弃无内容匹配，按位置对幸存的内容分块排序，然后应用服务的评分管线（作用域权重、会话分块的时域衰减、访问加成）并返回前 `limit` 条。分块出现在检索结果中时其 `accessCount` 递增。

## Model Experience

### 记忆召回与注入

#### What the model sees

本包不直接贡献任何面向模型的文本；它产出 `MemoryChunk` 记录，由 Consumer 渲染为检索结果与注入的 "Project memory" 快照。检索结果携带分块的来源、分数与路径；摘要从分块的第一行实质内容渲染。

#### Token effect

provider 存储并索引完整分块文本，但从不自行发送给模型。检索最多返回配置的结果上限；注入最多返回 `maxInjectedChunks` 条标题。召回成本随被召回分块的数量增长，每条受分块配置约束。

#### KV Cache effect

provider 不发起任何模型请求。召回由 Consumer 触发，其结果跟随可复用的请求前缀。

## Known Limitations and Deferred Work

- **仅 FTS**——向量路径（`chunks_vec` 表、混合评分、MMR 重排）不在计划内；每次检索都是 `fts-only`，零 LLM 或 embedding 调用。
- **未知中文复合词不可检索**——汉字段在建立索引与查询提取前用 `Intl.Segmenter`（ICU 词典）分词，并有一组精心整理的中文停用词过滤提取。词典未收录的复合词按单字符切分并随其他单字符词元一起丢弃，因此只有词典收录的中文词可检索。
- **可选文件监视器**——外部对记忆文件的编辑对 `read`（会刷新状态）可见，但外部编辑触发的索引刷新需要 `watcher.enabled: true`。监视器使用原生文件系统事件；某个根目录原生监视不可用时，回退到按 `watcher.pollIntervalMs` 周期轮询。
- **可选的归档保留期**——除非设置 `session.retentionDays`，否则会话归档无限累积；剪除在打开时（startup 或 first-search）以及监视器刷新时运行。
- **可选的 dream 整合**——dream 默认关闭，且需要 `dsh-llm` 运行时与一个 provider 路由，因此无 key 的回放保持确定性；该趟尽力而为（flush 后即发即弃、会合并），一趟读取与追加之间若有并发模型写入 `MEMORY.md`，可能被覆盖。