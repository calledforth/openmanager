import { describe, expect, it } from 'vitest'
import { projectThread } from '@openmanager/app-core/logic'
import type { ThreadState } from '@openmanager/environment-client'

import { highlightCode, languageLabel } from '../src/components/parts/highlight'
import type { HomeSession } from '../src/home/rows'
import { childSessionsOf } from '../src/session/child-sessions'
import {
  doneThread,
  failedThread,
  longThread,
  permissionThread,
  workingThread,
} from '../src/session/fixture-threads'
import {
  clockFromKey,
  clockKey,
  formatClock,
  formatElapsed,
  statusClockOf,
  statusLineView,
} from '../src/session/status-line'
import { turnIdOf } from '../src/session/thread-rows'
import { noticesOfTurn } from '../src/session/turn-notices'

const NOW = Date.parse('2026-10-22T10:00:00.000Z')

const session = (patch: Partial<HomeSession>): HomeSession => ({
  externalId: 's-1',
  title: 'A session',
  status: 'running',
  providerId: 'claude',
  isDriven: false,
  workspacePath: 'C:/repo',
  ...patch,
})

describe('status line', () => {
  it('is the listed status, timed from the open turn the server started', () => {
    const thread = workingThread(NOW)
    const view = statusLineView(session({ status: 'running' }), thread)
    expect(view).toMatchObject({ mark: 'working', label: 'Working', detail: null })
    expect(view?.clock).toEqual({ kind: 'elapsed', since: NOW - 130_000 })
    expect(formatClock(view!.clock!, NOW)).toBe('2m 10s')
  })

  it('counts a wait from when the environment asked', () => {
    const thread = permissionThread(NOW)
    const view = statusLineView(session({ status: 'waiting', waitingOn: 'permission' }), thread)
    expect(view).toMatchObject({ mark: 'needs', label: 'Needs you' })
    expect(formatClock(view!.clock!, NOW)).toBe('waiting 2m')
  })

  it('ignores a request the environment no longer waits on', () => {
    const thread = permissionThread(NOW)
    const resolved: ThreadState = {
      ...thread,
      interactions: thread.interactions.map((pending) => ({
        ...pending,
        interaction: {
          ...pending.interaction,
          lifecycle: { ...pending.interaction.lifecycle!, state: 'resolved' },
        },
      })) as ThreadState['interactions'],
    }
    expect(statusClockOf('needs', resolved)).toBeNull()
  })

  it('says why a session failed, in the environment words, and how long ago', () => {
    const thread = failedThread(NOW)
    const view = statusLineView(session({ status: 'error' }), thread)
    expect(view).toMatchObject({
      mark: 'error',
      label: 'Failed',
      detail: 'The provider process exited (code 1).',
    })
    expect(formatClock(view!.clock!, NOW)).toBe('3h ago')
  })

  it('ages a finished session from its last turn', () => {
    const view = statusLineView(session({ status: 'done' }), doneThread(NOW))
    expect(view?.mark).toBe('done')
    expect(view?.clock?.kind).toBe('ago')
  })

  it('shows no line at rest and no time without a server stamp', () => {
    expect(statusLineView(session({ status: 'ready' }), null)).toBeNull()
    expect(statusLineView(session({ status: 'running' }), null)).toMatchObject({
      mark: 'working',
      clock: null,
    })
    const unstamped = workingThread(NOW)
    unstamped.turns = unstamped.turns.map(({ startedAt: _drop, ...turn }) => turn)
    expect(statusClockOf('working', unstamped)).toBeNull()
  })

  it('never shows a negative time when the phone clock is behind', () => {
    expect(formatClock({ kind: 'elapsed', since: NOW + 5_000 }, NOW)).toBe('0s')
  })

  it('formats durations and round-trips a clock through its key', () => {
    expect(formatElapsed(9_400)).toBe('9s')
    expect(formatElapsed(120_000)).toBe('2m')
    expect(formatElapsed(3_840_000)).toBe('1h 4m')
    const clock = { kind: 'waiting', since: NOW } as const
    expect(clockFromKey(clockKey(clock))).toEqual(clock)
    expect(clockFromKey(clockKey(null))).toBeNull()
  })
})

describe('code highlighting', () => {
  it('reads comments, strings, numbers and keywords', () => {
    const [line] = highlightCode("const tier = 'team' // the default\n", 'ts')
    expect(line).toEqual([
      { kind: 'keyword', text: 'const' },
      { kind: 'plain', text: ' tier = ' },
      { kind: 'string', text: "'team'" },
      { kind: 'plain', text: ' ' },
      { kind: 'comment', text: '// the default' },
    ])
    expect(highlightCode('x = 0x1f + 2.5e3', 'py')[0]).toContainEqual({
      kind: 'number',
      text: '0x1f',
    })
  })

  it('carries a block comment across lines', () => {
    const lines = highlightCode('/* one\ntwo */ let a', 'js')
    expect(lines[0]).toEqual([{ kind: 'comment', text: '/* one' }])
    expect(lines[1]?.[0]).toEqual({ kind: 'comment', text: 'two */' })
    expect(lines[1]).toContainEqual({ kind: 'keyword', text: 'let' })
  })

  it('uses the comment style of the language and leaves unknown ones plain', () => {
    expect(highlightCode('echo hi # note', 'bash')[0]?.at(-1)).toEqual({
      kind: 'comment',
      text: '# note',
    })
    expect(highlightCode('select * from t -- all', 'sql')[0]?.at(-1)).toEqual({
      kind: 'comment',
      text: '-- all',
    })
    expect(highlightCode("it's 'plain' text", 'made-up')[0]).toEqual([
      { kind: 'plain', text: "it's 'plain' text" },
    ])
    expect(languageLabel('ts title="x"')).toBe('ts')
    expect(languageLabel(undefined)).toBe('')
  })

  it('keeps every character of the source', () => {
    const source = 'fn main() { let s = "a\\"b"; /* c */ 42 } // done'
    const joined = highlightCode(source, 'rust')
      .map((tokens) => tokens.map((token) => token.text).join(''))
      .join('\n')
    expect(joined).toBe(source)
  })
})

describe('transcript rows', () => {
  it('names the turn of an assistant row by the projection key', () => {
    const projection = projectThread(doneThread(NOW))
    const assistant = projection.messages.find((message) => message.role === 'assistant')!
    const user = projection.messages.find((message) => message.role === 'user')!
    expect(turnIdOf(assistant)).toBe('turn-d1')
    expect(turnIdOf(user)).toBeNull()
    expect(turnIdOf({ role: 'assistant', rowKey: 'send:1' })).toBeNull()
  })

  it('hands out the same notices array until the list changes', () => {
    const thread = failedThread(NOW)
    const first = noticesOfTurn(thread.notices, 'turn-f1')
    expect(first).toEqual(['Retried once after the provider was overloaded.'])
    expect(noticesOfTurn(thread.notices, 'turn-f1')).toBe(first)
    expect(noticesOfTurn(thread.notices, 'other')).toBe(noticesOfTurn([], 'x'))
  })

  it('lists a session children, newest first', () => {
    const rows = [
      session({ externalId: 'p' }),
      session({ externalId: 'c1', parentExternalId: 'p', updatedAt: '2026-10-22T09:00:00Z' }),
      session({ externalId: 'c2', parentExternalId: 'p', updatedAt: '2026-10-22T09:30:00Z' }),
      session({ externalId: 'other', parentExternalId: 'q' }),
    ]
    expect(childSessionsOf(rows, 'p').map((row) => row.externalId)).toEqual(['c2', 'c1'])
  })

  it('builds the long fixture as 200 messages', () => {
    expect(projectThread(longThread(NOW)).messages).toHaveLength(200)
  })
})
