import { describe, expect, it } from 'vitest'
import { createMessage, createToolResultMessage, createUserMessage, CallId } from '@deepseek-ai/dsh-llm'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  MEMORY_ARCHIVE_MIN_QUERY_BYTES,
  MEMORY_ARCHIVE_MIN_USER_MESSAGES,
  archiveDateParts,
  archiveIsExpired,
  archiveMessageCounts,
  meetsSessionArchiveGate,
  realUserQueryTexts,
  renderArchiveCard,
  sessionArchiveName,
  sessionArchiveSid8,
  slugify,
  type ArchiveMessageCounts,
} from '../src/archive.ts'

function buildSession(): Session {
  const session = Session.create(SessionId('archive-unit'))
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'first query about the deployment convention' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'second query about the release checklist' }], source: { kind: 'plugin', plugin: 'goal' },
  }), { surfaceOp: 'append' })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'third query about running in CI' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 1, step: 1,
    message: createMessage({
      role: 'assistant', content: [{ type: 'text', text: 'reply' }],
      source: { kind: 'model', ...{ provider: 'mock', model: 'mock' } },
    }),
  }, { surfaceOp: 'append' })
  session.append('tool/result', {
    turn: 1, step: 1,
    message: createToolResultMessage({
      callId: CallId('c1'), content: [{ type: 'text', text: 'ok' }], isError: false,
    }),
  }, { surfaceOp: 'append' })
  return session
}

describe('realUserQueryTexts', () => {
  it('returns only user-source text blocks in log order', () => {
    const queries = realUserQueryTexts(buildSession().events)
    expect(queries).toEqual([
      'first query about the deployment convention',
      'third query about running in CI',
    ])
  })

  it('joins multiple text blocks and skips non-text blocks', () => {
    const session = Session.create(SessionId('archive-blocks'))
    session.append('user/message', createUserMessage({
      content: [
        { type: 'text', text: 'part one ' },
        { type: 'image', attachment: { attachmentId: AttachmentId('img'), mediaType: 'image/png', bytes: 1, width: 1, height: 1 } },
        { type: 'text', text: 'part two' },
      ],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    expect(realUserQueryTexts(session.events)).toEqual(['part one part two'])
  })
})

describe('archiveMessageCounts', () => {
  it('counts user, assistant, and tool results, excluding injected prompts', () => {
    const counts = archiveMessageCounts(buildSession().events)
    expect(counts).toEqual({ user: 2, assistant: 1, toolResults: 1 } satisfies ArchiveMessageCounts)
  })

  it('returns zeroes for an empty log', () => {
    expect(archiveMessageCounts([])).toEqual({ user: 0, assistant: 0, toolResults: 0 })
  })

  it('ignores other event kinds', () => {
    const session = Session.create(SessionId('archive-other'))
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(archiveMessageCounts(session.events)).toEqual({ user: 0, assistant: 0, toolResults: 0 })
  })
})

describe('meetsSessionArchiveGate', () => {
  it('rejects fewer than the minimum user messages', () => {
    expect(meetsSessionArchiveGate(['a'.repeat(100), 'b'.repeat(100)])).toBe(false)
  })

  it('rejects the minimum messages under the byte floor', () => {
    const short = ['ab', 'cd', 'ef']
    expect(short).toHaveLength(MEMORY_ARCHIVE_MIN_USER_MESSAGES)
    expect(meetsSessionArchiveGate(short)).toBe(false)
  })

  it('accepts the minimum messages at exactly the byte floor', () => {
    const per = Math.ceil(MEMORY_ARCHIVE_MIN_QUERY_BYTES / MEMORY_ARCHIVE_MIN_USER_MESSAGES)
    const queries = Array.from({ length: MEMORY_ARCHIVE_MIN_USER_MESSAGES }, () => 'x'.repeat(per))
    expect(meetsSessionArchiveGate(queries)).toBe(true)
  })
})

describe('slugify', () => {
  it('lowercases and maps non-alphanumerics to collapsed dashes', () => {
    expect(slugify('First   Query!! $about$', 30)).toBe('first-query-about')
  })

  it('handles non-ASCII alphanumerics as dashes', () => {
    expect(slugify('部署Convention发布', 30)).toBe('convention')
  })

  it('truncates to the maximum length and trims edge dashes', () => {
    expect(slugify('first query about the deployment convention', 20)).toBe('first-query-about-th')
  })

  it('returns an empty string for a dash-only input', () => {
    expect(slugify('!!', 30)).toBe('')
  })
})

describe('archiveDateParts', () => {
  it('renders a UTC date and stamp from an epoch millisecond', () => {
    const epoch = Date.UTC(2026, 7, 17, 9, 30, 0)
    expect(archiveDateParts(epoch)).toEqual({ date: '2026-08-17', stamp: '2026-08-17 09:30 UTC' })
  })
})

describe('sessionArchiveSid8', () => {
  it('returns 8 lowercase hex characters and is deterministic', () => {
    const first = sessionArchiveSid8('session-1')
    expect(first).toMatch(/^[0-9a-f]{8}$/)
    expect(sessionArchiveSid8('session-1')).toBe(first)
    expect(sessionArchiveSid8('session-2')).not.toBe(first)
  })
})

describe('sessionArchiveName', () => {
  it('joins the date, slug, and id suffix', () => {
    expect(sessionArchiveName('2026-08-17', 'first-query', 'deadbeef')).toBe('2026-08-17-first-query-deadbeef.md')
  })
})

describe('archiveIsExpired', () => {
  const cutoffMs = Date.UTC(2026, 7, 17)

  it('expires a session date strictly older than the cutoff day', () => {
    expect(archiveIsExpired('2026-08-16-first-query-deadbeef.md', cutoffMs)).toBe(true)
  })

  it('keeps a session dated on or after the cutoff day', () => {
    expect(archiveIsExpired('2026-08-17-first-query-deadbeef.md', cutoffMs)).toBe(false)
    expect(archiveIsExpired('2026-08-18-first-query-deadbeef.md', cutoffMs)).toBe(false)
  })

  it('never expires a name that is not a valid archive name', () => {
    expect(archiveIsExpired('README.md', cutoffMs)).toBe(false)
  })
})

describe('renderArchiveCard', () => {
  it('renders the full card with topics', () => {
    const card = renderArchiveCard('2026-08-17 09:30 UTC', { user: 2, assistant: 1, toolResults: 1 }, [
      'first query about the deployment convention',
      'third query about running in CI',
    ])
    expect(card).toBe(
      '## Session Summary\n'
      + '\n'
      + '- **Messages:** 2 user, 1 assistant, 1 tool results\n'
      + '- **Date:** 2026-08-17 09:30 UTC\n'
      + '\n'
      + '## Topics Discussed\n'
      + '\n'
      + '1. first query about the deployment convention\n'
      + '2. third query about running in CI\n',
    )
  })

  it('omits the topics section when there are none', () => {
    const card = renderArchiveCard('2026-08-17 09:30 UTC', { user: 0, assistant: 0, toolResults: 0 }, [])
    expect(card).toBe(
      '## Session Summary\n'
      + '\n'
      + '- **Messages:** 0 user, 0 assistant, 0 tool results\n'
      + '- **Date:** 2026-08-17 09:30 UTC\n',
    )
  })
})
