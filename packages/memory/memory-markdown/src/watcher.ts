/**
 * File-system watcher for memory directories.
 *
 * Watches each configured root with `fs.watch`, coalescing change events for
 * markdown files into a single debounced callback. Non-markdown events (for
 * example the SQLite index living beside the global memory file) are dropped
 * so the provider's own index writes never re-trigger a refresh. When native
 * watching is unavailable for any root (a missing directory or an
 * unsupported filesystem), all roots fall back to a periodic full-refresh
 * poll so external edits are still noticed.
 *
 * Timers and watcher handles are non-persistent and unref'd: they never keep
 * a loader process alive, and `dispose` guarantees no callback fires after
 * teardown.
 *
 * @module @deepseek-ai/dsh-memory-markdown
 */

import { watch, type FSWatcher } from 'node:fs'

/** MemoryWatcher construction options. */
export interface MemoryWatcherOptions {
  /** Root directories to watch. */
  readonly dirs: readonly string[]
  /** Milliseconds to coalesce rapid change events into one callback. */
  readonly debounceMs: number
  /** Milliseconds between polling probes when native watching is unavailable. */
  readonly pollIntervalMs: number
  /** Called after the debounce or a poll probe observes a change. */
  readonly onChange: () => void
}

/** Coalescing file-system watcher over memory directories. */
export class MemoryWatcher {
  private readonly _native = new Set<FSWatcher>()
  private _debounce: NodeJS.Timeout | undefined
  private _poll: NodeJS.Timeout | undefined
  private _disposed = false

  constructor(private readonly _options: MemoryWatcherOptions) {}

  /** Start watching every configured root. */
  start(): void {
    let nativeFailed = false
    for (const dir of this._options.dirs) {
      try {
        const watcher = watch(dir, { persistent: false }, (_event, filename) => {
          if (filename === null) {
            this._schedule()
            return
          }
          const name = Buffer.isBuffer(filename) ? filename.toString('utf8') : filename
          if (name.endsWith('.md')) this._schedule()
        })
        watcher.on('error', () => {
          this._fallbackToPolling()
        })
        this._native.add(watcher)
      } catch {
        nativeFailed = true
      }
    }
    if (nativeFailed) this._fallbackToPolling()
  }

  /** Stop watching, clear timers, and guarantee no callback fires again. */
  dispose(): void {
    this._disposed = true
    if (this._debounce !== undefined) {
      clearTimeout(this._debounce)
      this._debounce = undefined
    }
    if (this._poll !== undefined) {
      clearInterval(this._poll)
      this._poll = undefined
    }
    for (const watcher of this._native) watcher.close()
    this._native.clear()
  }

  private _schedule(): void {
    if (this._disposed) return
    if (this._debounce !== undefined) clearTimeout(this._debounce)
    this._debounce = setTimeout(() => {
      this._debounce = undefined
      this._options.onChange()
    }, this._options.debounceMs)
    this._debounce.unref()
  }

  private _fallbackToPolling(): void {
    if (this._disposed) return
    for (const watcher of this._native) watcher.close()
    this._native.clear()
    if (this._poll === undefined) {
      this._poll = setInterval(() => {
        this._options.onChange()
      }, this._options.pollIntervalMs)
      this._poll.unref()
    }
  }
}
