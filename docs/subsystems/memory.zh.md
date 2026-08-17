# 精炼记忆

[English](memory.md) | 中文

跨会话精炼记忆能力是一项[能力 seam](../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md)：它持久保存智能体选择跨会话记住的知识，并通过混合召回将其重新呈现。该能力拆分到多个包：Service Definition（[dsh-memory](../../packages/memory/memory)，`ctx.memory`）、Service Provider（[dsh-memory-markdown](../../packages/memory/memory-markdown)，宿主主目录下的 markdown 文件配合 SQLite FTS5 索引）和 Consumer（[dsh-tool-memory](../../packages/memory/tool-memory)，`memory_search`/`memory_get`/`memory_set` 工具与会话开始注入）。记忆是**一项可选能力**，不属于 agent loop（智能体循环）主干，因此其词汇记录在此处，而不在 [core.md](core.md) 中。

源码：[`packages/memory/memory/src/index.ts`](../../packages/memory/memory/src/index.ts)

## 作用域与存储布局

精炼记忆有三个作用域。`global` 保存跨所有工作区与会话共享的知识；`workspace` 限定于一个项目检出；`session` 保存每会话归档。markdown provider 将 `global` 文件解析到宿主主目录根，将 `workspace` 文件解析到由已解析工作区路径的稳定哈希派生的目录，因此同一项目的两个检出共享一份记忆，而不存储明文工作区路径。记忆文件以带品牌的 `MemoryPath` 寻址：全局或工作区根目录下的 `MEMORY.md`，或 `sessions/` 下带日期的会话归档。

```ts type-equiv
/** Curated-memory scope; `session` chunks decay, evergreen scopes do not. */
type MemoryScope = 'global' | 'workspace' | 'session'
```

```ts type-equiv
/** Opaque identity of one memory file, branded to prevent cross-boundary confusion with plain paths. */
type MemoryPath = Branded<'MemoryPath'>
```

## 分块与索引

文件被拆分为尊重 markdown 结构（标题、段落和代码块）的分块，每个分块携带活动标题栈作为上下文以保证自包含。确定性内容哈希使分块在未更改文本的重新索引中保持稳定；分块记录其在源文件中的从 0 开始的起止行。provider 将分块存储在专用 SQLite 索引中，其 schema 版本和应用 id 防止无关数据库误用；分块文本以 contentless FTS5 表建立索引。向量检索是可选开启的，在仅 FTS 操作中从不导入，因此未配置 embedding provider 的部署执行零 LLM 或 embedding 调用。

```ts type-equiv
/** One indexed chunk of a memory file. */
interface MemoryChunk {
  /** Deterministic content hash, stable across reindexes of unchanged text. */
  readonly id: MemoryChunkId
  /** Owning memory file path. */
  readonly path: MemoryPath
  /** 0-based start line in the source file. */
  readonly startLine: number
  /** 0-based end line (exclusive) in the source file. */
  readonly endLine: number
  /** Chunk text including ancestor header context. */
  readonly text: string
  /** Curated scope the owning file belongs to. */
  readonly source: MemoryScope
  /** Number of times the chunk appeared in recall results. */
  readonly accessCount: number
  /** Creation epoch millisecond. */
  readonly createdAt: number
}
```

## 评分

markdown provider 按关键词扫描结果集内的位置对 FTS 命中排序，再应用服务配置的管线：常青作用域（`global`、`workspace`）保留基础分数，`session` 分块按可配置的半衰期（默认 30 天）指数衰减，每个作用域带权重和封顶 0.2 的访问频率加成。合并分数被限制在 `[0, 1]`；低于 `minScore` 的结果被丢弃。结构性为空或匹配样板脚手架模板（`this file is managed`、`auto-generated`、`do not edit`、`curated knowledge`）的分块绝不会出现在结果或注入中。

```ts type-equiv
/** Retrieval mode selected by the search pipeline. */
type MemoryRetrievalMode = 'fts-only' | 'hybrid' | 'embedding-fallback'
```

```ts type-equiv
/** One memory search result. */
interface MemorySearchResult {
  readonly chunk: MemoryChunk
  /** Merged score clamped to `[0, 1]`. */
  readonly score: number
  /** Rendering-friendly snippet with match highlighting stripped. */
  readonly snippet: string
  /** Retrieval mode actually used for this query. */
  readonly mode: MemoryRetrievalMode
}
```

## 会话开始注入

`ctx.memory.inject()` 返回按访问次数随后按创建时间排序的常青分块，并排除无内容分块。Consumer 将其中最多 `maxInjectedChunks` 个注入到每次会话开始，作为 `plugin` 消息来源下的 "Project memory" 快照，使新会话以先前会话选择记录的持久结论开场。注入是尽力而为的：provider 失败会被记录日志，会话在无快照的情况下继续。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxmemory--memoryservice-abstract-seam"></a>

### `ctx.memory` — `MemoryService` (abstract seam)

Unified cross-session memory service.

Search, read, write, and list are backend-independent concrete contracts; a backend implements storage, indexing, and retrieval on the same `ctx.memory` service.

```ts cordis-catalog
/**
 * Search curated memory with the configured hybrid pipeline.
 * @param request - query, optional scope/limit/min-score overrides, cancellation.
 * @returns ranked results with per-result mode and coverage metadata.
 */
abstract search(request: MemorySearchRequest): Promise<MemorySearchPage>

/**
 * Read the current content of one memory file.
 * @param path - branded memory file path.
 * @returns the file's full text.
 * @throws {@link MemoryError} `MEMORY_FILE_NOT_FOUND` when absent.
 */
abstract read(path: MemoryPath): Promise<string>

/**
 * Write one memory file, replacing existing content atomically.
 * @param path - branded memory file path.
 * @param content - new full text content.
 */
abstract write(path: MemoryPath, content: string): Promise<void>

/**
 * List known memory files with size and modification metadata.
 * @returns files in deterministic order.
 */
abstract list(): Promise<readonly MemoryFile[]>

/**
 * Return the chunks of one memory file, refreshed from durable state.
 * @param path - branded memory file path.
 * @returns current chunks in document order.
 * @throws {@link MemoryError} `MEMORY_FILE_NOT_FOUND` when absent.
 */
abstract readChunks(path: MemoryPath): Promise<readonly MemoryChunk[]>

/**
 * Return top evergreen chunks for session-start injection.
 * @param request - maximum chunk count and optional cancellation.
 * @returns evergreen chunks ranked for injection, content-free chunks excluded.
 */
abstract inject(request: MemoryInjectRequest): Promise<readonly MemoryChunk[]>
```

Source: [`packages/memory/memory/src/index.ts:56`](../../packages/memory/memory/src/index.ts)
<!-- END GENERATED cordis-surface -->