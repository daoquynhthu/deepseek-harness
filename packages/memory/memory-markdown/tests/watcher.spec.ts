import { Buffer } from 'node:buffer'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

interface FakeWatchControl {
  path: string
  options: Record<string, unknown>
  listener(event: string, filename: string | Buffer | null): void
  errorHandlers: Array<() => void>
  closeCalls: number
}

const watcherHarness = vi.hoisted(() => ({
  watchers: [] as FakeWatchControl[],
  throwFor: new Set<string>(),
  captured: [] as string[],
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    watch(path: string, options: Record<string, unknown>, listener: FakeWatchControl['listener']) {
      if (watcherHarness.throwFor.has(path)) {
        watcherHarness.captured.push(`throw:${path}`)
        throw new Error('native watching unavailable')
      }
      const control: FakeWatchControl = {
        path,
        options,
        listener,
        errorHandlers: [],
        closeCalls: 0,
      }
      watcherHarness.watchers.push(control)
      watcherHarness.captured.push(`watch:${path}`)
      return {
        on(event: string, handler: () => void) {
          if (event === 'error') control.errorHandlers.push(handler)
        },
        close() {
          control.closeCalls += 1
        },
      }
    },
  }
})

const { MemoryWatcher } = await import('../src/watcher.ts')

function debounceWatcher(onChange: () => void): InstanceType<typeof MemoryWatcher> {
  return new MemoryWatcher({ dirs: ['/a', '/b'], debounceMs: 50, pollIntervalMs: 100, onChange })
}

beforeEach(() => {
  vi.useFakeTimers()
  watcherHarness.watchers.length = 0
  watcherHarness.throwFor.clear()
  watcherHarness.captured.length = 0
})

afterEach(() => {
  vi.useRealTimers()
})

describe('MemoryWatcher', () => {
  it('watches every root and reports markdown events once after the debounce', () => {
    const onChange = vi.fn()
    const watcher = debounceWatcher(onChange)
    watcher.start()
    expect(watcherHarness.watchers.map(control => control.path).sort()).toEqual(['/a', '/b'])
    expect(watcherHarness.watchers.every(control => control.options.persistent === false)).toBe(true)
    for (const control of watcherHarness.watchers) control.listener('change', 'MEMORY.md')
    expect(onChange).not.toHaveBeenCalled()
    vi.advanceTimersByTime(50)
    expect(onChange).toHaveBeenCalledTimes(1)
    watcher.dispose()
  })

  it('coalesces rapid events into a single callback', () => {
    const onChange = vi.fn()
    const watcher = debounceWatcher(onChange)
    watcher.start()
    const control = watcherHarness.watchers[0]!
    control.listener('change', 'a.md')
    control.listener('change', 'b.md')
    vi.advanceTimersByTime(25)
    control.listener('change', 'c.md')
    vi.advanceTimersByTime(49)
    expect(onChange).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onChange).toHaveBeenCalledTimes(1)
    control.listener('change', 'd.md')
    vi.advanceTimersByTime(50)
    expect(onChange).toHaveBeenCalledTimes(2)
    watcher.dispose()
  })

  it('ignores non-markdown events and reports null and buffer filenames', () => {
    const onChange = vi.fn()
    const watcher = debounceWatcher(onChange)
    watcher.start()
    const control = watcherHarness.watchers[0]!
    control.listener('change', 'index.sqlite-wal')
    control.listener('change', 'MEMORY.md.tmp')
    vi.advanceTimersByTime(60)
    expect(onChange).not.toHaveBeenCalled()
    control.listener('change', null)
    vi.advanceTimersByTime(50)
    expect(onChange).toHaveBeenCalledTimes(1)
    control.listener('change', Buffer.from('session.md'))
    vi.advanceTimersByTime(50)
    expect(onChange).toHaveBeenCalledTimes(2)
    watcher.dispose()
  })

  it('falls back to polling when a root cannot be watched natively', () => {
    const onChange = vi.fn()
    watcherHarness.throwFor.add('/missing')
    const watcher = new MemoryWatcher({ dirs: ['/ok', '/missing'], debounceMs: 50, pollIntervalMs: 100, onChange })
    watcher.start()
    expect(watcherHarness.captured).toContain('throw:/missing')
    expect(watcherHarness.watchers.every(control => control.closeCalls === 1)).toBe(true)
    vi.advanceTimersByTime(100)
    expect(onChange).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(100)
    expect(onChange).toHaveBeenCalledTimes(2)
    watcher.dispose()
  })

  it('switches to polling when a native watcher reports an error', () => {
    const onChange = vi.fn()
    const watcher = debounceWatcher(onChange)
    watcher.start()
    expect(watcherHarness.watchers).toHaveLength(2)
    watcherHarness.watchers[0]!.errorHandlers[0]!()
    expect(watcherHarness.watchers.every(control => control.closeCalls === 1)).toBe(true)
    vi.advanceTimersByTime(100)
    expect(onChange).toHaveBeenCalledTimes(1)
    watcherHarness.watchers[1]!.errorHandlers[0]!()
    vi.advanceTimersByTime(100)
    expect(onChange).toHaveBeenCalledTimes(2)
    watcher.dispose()
    expect(watcherHarness.watchers.every(control => control.closeCalls === 1)).toBe(true)
  })

  it('dispose closes watchers and prevents further callbacks', () => {
    const onChange = vi.fn()
    const watcher = debounceWatcher(onChange)
    watcher.start()
    const control = watcherHarness.watchers[0]!
    control.listener('change', 'MEMORY.md')
    watcher.dispose()
    expect(control.closeCalls).toBe(1)
    vi.advanceTimersByTime(1000)
    expect(onChange).not.toHaveBeenCalled()
    control.listener('change', 'MEMORY.md')
    control.errorHandlers[0]!()
    expect(onChange).not.toHaveBeenCalled()
    watcher.dispose()
    expect(control.closeCalls).toBe(1)
  })

  it('dispose with no active handles is safe', () => {
    const watcher = debounceWatcher(vi.fn())
    watcher.start()
    watcher.dispose()
    expect(watcherHarness.watchers[0]!.closeCalls).toBe(1)
    expect(() => {
      watcher.dispose()
    }).not.toThrow()
  })
})
