import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { SessionStore, type Session } from '@deepseek-ai/dsh-session'
import MarkdownMemoryService, { type Config } from '../src/index.ts'
import { resolveMemoryLayout } from '../src/layout.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

async function temporaryPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-archive-'))
  temporaryDirectories.push(directory)
  return directory
}

function user(session: Session, text: string): void {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

async function boot(config: Partial<Config> = {}): Promise<{ ctx: Context; root: string }> {
  const root = await temporaryPath()
  const ctx = new Context()
  await ctx.plugin(MarkdownMemoryService, { workspace: '/work/alpha', root, openAt: 'never', ...config })
  await ctx.plugin(SessionStore)
  return { ctx, root }
}

describe('session archive on flush', () => {
  it('writes no archive for a session below the message gate', async () => {
    const { ctx } = await boot()
    await ctx.plugin(Object.assign((inner: Context) => {
      const session = inner.sessions.create()
      user(session, 'only a single query about the convention')
      void session
    }, { inject: ['sessions'] }))

    const session = ctx.sessions.list()[0]!
    await ctx.sessions.flush(session)
    expect(await ctx.memory.list()).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('writes no archive for a subagent session even when substantial', async () => {
    const { ctx } = await boot()
    await ctx.plugin(Object.assign((inner: Context) => {
      const session = inner.sessions.create(undefined, { meta: { origin: 'subagent' } })
      user(session, 'first query about the deployment convention')
      user(session, 'second query about the release checklist')
      user(session, 'third query about running in CI')
      void session
    }, { inject: ['sessions'] }))

    const session = ctx.sessions.list()[0]!
    await ctx.sessions.flush(session)
    expect(await ctx.memory.list()).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('writes a substantial root session archive at flush', async () => {
    const { ctx, root } = await boot()
    await ctx.plugin(Object.assign((inner: Context) => {
      const session = inner.sessions.create()
      user(session, 'first query about the deployment convention')
      user(session, 'second query about the release checklist')
      user(session, 'third query about running in CI')
      void session
    }, { inject: ['sessions'] }))

    const session = ctx.sessions.list()[0]!
    await ctx.sessions.flush(session)

    const files = await ctx.memory.list()
    expect(files).toHaveLength(1)
    expect(files[0]!.path).toMatch(/^sessions\/\d{4}-\d{2}-\d{2}-[a-z0-9-]+-[0-9a-f]{8}\.md$/)

    await ctx.fiber.dispose()

    const layout = resolveMemoryLayout('/work/alpha', root, undefined)
    const card = await readFile(join(layout.sessionsDir, files[0]!.path.slice('sessions/'.length)), 'utf8')
    expect(card).toContain('## Session Summary')
    expect(card).toContain('3 user, 0 assistant, 0 tool results')
    expect(card).toContain('## Topics Discussed')
    expect(card).toContain('1. first query about the deployment convention')
    expect(card).toContain('2. second query about the release checklist')
    expect(card).toContain('3. third query about running in CI')
  })

  it('replaces the archive content on a later flush', async () => {
    const { ctx, root } = await boot()
    await ctx.plugin(Object.assign((inner: Context) => {
      const session = inner.sessions.create()
      user(session, 'first query about the deployment convention')
      user(session, 'second query about the release checklist')
      user(session, 'third query about running in CI')
      void session
    }, { inject: ['sessions'] }))

    const session = ctx.sessions.list()[0]!
    await ctx.sessions.flush(session)
    user(session, 'fourth query about the postmortem process')
    await ctx.sessions.flush(session)

    const files = await ctx.memory.list()
    expect(files).toHaveLength(1)
    await ctx.fiber.dispose()

    const layout = resolveMemoryLayout('/work/alpha', root, undefined)
    const card = await readFile(join(layout.sessionsDir, files[0]!.path.slice('sessions/'.length)), 'utf8')
    expect(card).toContain('4 user, 0 assistant, 0 tool results')
    expect(card).toContain('1. first query about the deployment convention')
  })

  it('writes nothing when session archival is disabled', async () => {
    const { ctx } = await boot({ session: { saveOnEnd: false } })
    await ctx.plugin(Object.assign((inner: Context) => {
      const session = inner.sessions.create()
      user(session, 'first query about the deployment convention')
      user(session, 'second query about the release checklist')
      user(session, 'third query about running in CI')
      void session
    }, { inject: ['sessions'] }))

    const session = ctx.sessions.list()[0]!
    await ctx.sessions.flush(session)
    expect(await ctx.memory.list()).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('falls back to the session slug when the first query has no text', async () => {
    const { ctx, root } = await boot()
    await ctx.plugin(Object.assign((inner: Context) => {
      const session = inner.sessions.create()
      session.append('user/message', createUserMessage({
        content: [{ type: 'image', attachment: { attachmentId: AttachmentId('img'), mediaType: 'image/png', bytes: 1, width: 1, height: 1 } }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      user(session, 'second query about the release checklist')
      user(session, 'third query about running in CI')
      void session
    }, { inject: ['sessions'] }))

    const session = ctx.sessions.list()[0]!
    await ctx.sessions.flush(session)

    const files = await ctx.memory.list()
    expect(files).toHaveLength(1)
    expect(files[0]!.path).toMatch(/^sessions\/\d{4}-\d{2}-\d{2}-session-[0-9a-f]{8}\.md$/)

    await ctx.fiber.dispose()

    const layout = resolveMemoryLayout('/work/alpha', root, undefined)
    const card = await readFile(join(layout.sessionsDir, files[0]!.path.slice('sessions/'.length)), 'utf8')
    expect(card).toContain('- **Messages:** 3 user, 0 assistant, 0 tool results')
  })
})
