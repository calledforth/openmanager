import { describe, expect, it } from 'vitest'
import { projectThread } from '@openmanager/app-core/logic'
import type { ThreadState } from '@openmanager/environment-client'

import { highlightCode, languageLabel } from '../src/components/parts/highlight'
import {
  foldSettledTurn,
  toolCallCount,
  turnLayout,
  workGroupLabel,
} from '../src/components/parts/work-groups'
import type { HomeSession } from '../src/home/rows'
import { childSessionsOf } from '../src/session/child-sessions'
import { createFixtureThread } from '../src/session/fixture-thread'
import {
  backgroundThread,
  doneThread,
  failedThread,
  longThread,
  permissionThread,
  workingThread,
} from '../src/session/fixture-threads'
import {
  AWAY_HIDE_PX,
  AWAY_SHOW_PX,
  awayFromLatest,
  createScrollFollower,
  FOLLOW_SLOP_PX,
} from '../src/session/scroll-anchor'
import { sessionMenuItems, type SessionMenuInput } from '../src/session/session-menu'
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
  it('reads a fence named after an inherited object property as plain text', () => {
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      const lines = highlightCode('x = 1 // not a comment here', name)
      expect(
        lines
          .flat()
          .map((token) => token.text)
          .join(''),
      ).toBe('x = 1 // not a comment here')
      expect(lines.flat().every((token) => token.kind === 'plain')).toBe(true)
    }
  })

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

  it('lists a session children in the order the shared listing gives them', () => {
    const rows = [
      session({ externalId: 'p' }),
      session({ externalId: 'c1', parentExternalId: 'p', updatedAt: '2026-10-22T09:00:00Z' }),
      session({ externalId: 'c2', parentExternalId: 'p', updatedAt: '2026-10-22T09:30:00Z' }),
      session({ externalId: 'other', parentExternalId: 'q' }),
    ]
    // c1 is older but listed first: the phone keeps the listing's order.
    expect(childSessionsOf(rows, 'p').map((row) => row.externalId)).toEqual(['c1', 'c2'])
  })

  it('builds the long fixture as 200 messages', () => {
    expect(projectThread(longThread(NOW)).messages).toHaveLength(200)
  })
})

describe('fixture thread store', () => {
  it('streams a turn the way the environment does, keeping untouched rows', () => {
    const fixture = createFixtureThread(longThread(NOW, 3))
    let notified = 0
    const stop = fixture.subscribe(() => {
      notified += 1
    })
    const before = fixture.getMessages()
    fixture.driver.begin('Say more.')
    fixture.driver.token('Hello')
    const during = fixture.getMessages()
    expect(during).toHaveLength(before.length + 2)
    // The rows that were there are the same objects: memoised rows skip.
    expect(during.slice(0, before.length).every((row, index) => row === before[index])).toBe(true)
    const reply = during.at(-1)!
    fixture.driver.token(' there')
    // A token changes the reply's body, not the list.
    expect(fixture.getMessages()).toBe(during)
    expect(fixture.stores.streamingStore.get(reply.externalId)?.content).toBe('Hello there')
    fixture.driver.settle()
    expect(fixture.getMessages().at(-1)?.isFinal).toBe(true)
    expect(notified).toBe(4)
    stop()
  })
})

describe('status line in the background', () => {
  it('counts background work from when the last turn ended', () => {
    const thread = backgroundThread(NOW)
    const view = statusLineView(
      session({ status: 'running', inBackground: true, backgroundTaskCount: 2 }),
      thread,
    )
    expect(view).toMatchObject({ mark: 'background', label: '2 in the background' })
    expect(view?.clock).toEqual({ kind: 'elapsed', since: NOW - 240_000 })
    expect(formatClock(view!.clock!, NOW)).toBe('4m')
  })
})

describe('work groups', () => {
  it('folds a settled turn before its answer and counts its tool calls', () => {
    const projection = projectThread(doneThread(NOW))
    const reply = projection.messages.find((message) => message.role === 'assistant')!
    const fold = foldSettledTurn(projection.byId.get(reply.externalId)!.content.parts ?? [])
    expect(fold.toolCount).toBe(3)
    expect(fold.work.map((part) => part.type)).toEqual(['reasoning', 'tool', 'tool', 'tool'])
    expect(fold.answer.map((part) => part.type)).toEqual(['text'])
  })

  it('labels a run as a line, live or settled', () => {
    const summary = { text: 'read 2 files', runningText: 'reading 2 files' }
    expect(workGroupLabel({ ...summary, isRunning: true })).toBe('Reading 2 files')
    expect(workGroupLabel({ ...summary, isRunning: false })).toBe('Read 2 files')
    expect(workGroupLabel({ text: '', runningText: '', isRunning: false })).toBe('')
    expect(toolCallCount(1)).toBe('1 tool call')
    expect(toolCallCount(4)).toBe('4 tool calls')
  })
})

/**
 * The transcript as the phone lays it out: cells top to bottom in reading
 * order, a viewport over them, and the real follower wired to it the way the
 * page wires it (a native scroll to the end, one frame later).
 */
function transcript(heights: number[], viewport = 600) {
  const cells = [...heights]
  let offset = 0
  const scheduled: Array<() => void> = []
  const scrolls: boolean[] = []
  const away: boolean[] = []
  const content = () => cells.reduce((sum, height) => sum + height, 0)
  const maxOffset = () => Math.max(0, content() - viewport)
  const metrics = () => ({ offset, contentHeight: content(), viewportHeight: viewport })
  const follower = createScrollFollower({
    scrollToEnd: (animated) => {
      scrolls.push(animated)
      offset = maxOffset()
      follower.onScroll(metrics())
    },
    schedule: (run) => scheduled.push(run),
    onAway: (next) => away.push(next),
  })
  const frame = () => {
    while (scheduled.length > 0) scheduled.shift()!()
  }
  /** A layout pass: the scroll view clamps its offset, then the content says its new size. */
  const layout = () => {
    if (offset > maxOffset()) {
      offset = maxOffset()
      follower.onScroll(metrics())
    }
    follower.onContentHeight(content())
  }
  const moveTo = (next: number) => {
    offset = Math.min(maxOffset(), Math.max(0, next))
    follower.onScroll(metrics())
  }
  layout()
  frame()
  return {
    scrolls,
    away,
    following: () => follower.following(),
    offset: () => offset,
    fromEnd: () => maxOffset() - offset,
    /** Which cell the screen's top edge is in and how far into it: what the reader is reading. */
    topLine() {
      let y = offset
      for (let index = 0; index < cells.length; index += 1) {
        if (y < cells[index]!) return { cell: index, into: y }
        y -= cells[index]!
      }
      return { cell: cells.length, into: y }
    },
    /** The live reply (the last cell) grows (or shrinks) by `by` without a frame passing. */
    growNoFrame(by: number) {
      cells[cells.length - 1]! += by
      layout()
    },
    frame,
    /** The live reply grows (or shrinks) by `by`, then a frame passes. */
    grow(by: number) {
      cells[cells.length - 1]! += by
      layout()
      frame()
    },
    /** A new row lands at the end. */
    append(height: number) {
      cells.push(height)
      layout()
      frame()
    },
    /** The reader drags by `dy` (negative is up) and lets go; a `fling` then carries on alone. */
    drag(dy: number, fling = 0) {
      follower.onDrag(true)
      moveTo(offset + dy)
      follower.onDrag(false)
      if (fling) moveTo(offset + fling)
    },
    hold: () => follower.onDrag(true),
    release: () => follower.onDrag(false),
    toLatest() {
      follower.toLatest()
      frame()
    },
  }
}

describe('scroll anchoring', () => {
  it('opens at the end and follows it, one native scroll per content-size change', () => {
    const list = transcript([400, 300, 500])
    expect(list.fromEnd()).toBe(0)
    const before = list.scrolls.length
    list.grow(24)
    expect(list.scrolls).toHaveLength(before + 1)
    expect(list.scrolls.at(-1)).toBe(false)
    expect(list.fromEnd()).toBe(0)
    list.append(80)
    expect(list.fromEnd()).toBe(0)
  })

  it('coalesces size changes within a frame, and asks nothing when a token changes no height', () => {
    const list = transcript([400, 300, 500])
    const before = list.scrolls.length
    list.growNoFrame(20)
    list.growNoFrame(20)
    list.growNoFrame(20)
    list.frame()
    expect(list.scrolls).toHaveLength(before + 1)
    list.grow(0)
    expect(list.scrolls).toHaveLength(before + 1)
  })

  it('never moves a reader who scrolled up inside the growing live reply', () => {
    // Two settled rows, then a live reply taller than the screen.
    const list = transcript([400, 300, 1500])
    list.drag(-400)
    const reading = list.topLine()
    // The reader is inside the live reply, well past the slop.
    expect(reading.cell).toBe(2)
    expect(list.fromEnd()).toBeGreaterThan(FOLLOW_SLOP_PX)
    const scrolls = list.scrolls.length
    const offset = list.offset()
    for (let token = 0; token < 40; token += 1) list.grow(22)
    expect(list.scrolls).toHaveLength(scrolls)
    expect(list.offset()).toBe(offset)
    expect(list.topLine()).toEqual(reading)
  })

  it('never moves a reader above the live reply, even when it settles shorter', () => {
    const list = transcript([400, 300, 900])
    list.drag(-700)
    const reading = list.topLine()
    expect(reading.cell).toBeLessThan(2)
    list.grow(300)
    list.grow(-500)
    expect(list.topLine()).toEqual(reading)
  })

  it('keeps a reader at the end there when the reply settles shorter', () => {
    const list = transcript([400, 300, 900])
    list.grow(-300)
    expect(list.fromEnd()).toBe(0)
    expect(list.following()).toBe(true)
  })

  it('follows nothing while a finger is on the list, and again once it lets go at the end', () => {
    const list = transcript([400, 300, 500])
    list.hold()
    const scrolls = list.scrolls.length
    list.grow(40)
    expect(list.scrolls).toHaveLength(scrolls)
    list.release()
    list.grow(40)
    expect(list.fromEnd()).toBe(0)
  })

  it('leaves the end on a fling up that began within the slop', () => {
    const list = transcript([400, 300, 1500])
    list.drag(-20, -500)
    expect(list.following()).toBe(false)
    const offset = list.offset()
    list.grow(60)
    expect(list.offset()).toBe(offset)
  })

  it('takes the reader back with the button, animated, and follows again', () => {
    const list = transcript([400, 300, 1500])
    list.drag(-900)
    expect(list.away.at(-1)).toBe(true)
    list.toLatest()
    expect(list.scrolls.at(-1)).toBe(true)
    expect(list.away.at(-1)).toBe(false)
    list.grow(30)
    expect(list.fromEnd()).toBe(0)
  })

  it('shows the scroll-to-latest button past one distance and hides it within a lower one', () => {
    expect(awayFromLatest(0, false)).toBe(false)
    expect(awayFromLatest(AWAY_SHOW_PX, false)).toBe(false)
    expect(awayFromLatest(AWAY_SHOW_PX + 1, false)).toBe(true)
    const between = (AWAY_SHOW_PX + AWAY_HIDE_PX) / 2
    expect(awayFromLatest(between, true)).toBe(true)
    expect(awayFromLatest(between, false)).toBe(false)
    expect(awayFromLatest(AWAY_HIDE_PX, true)).toBe(false)
  })
})

describe('settling in place', () => {
  it('keeps the layout a reader watched stream, and folds a turn that mounts settled', () => {
    expect(turnLayout({ streaming: true, watchedLive: true })).toBe('live')
    expect(turnLayout({ streaming: false, watchedLive: true })).toBe('live')
    expect(turnLayout({ streaming: false, watchedLive: false })).toBe('folded')
  })
})

describe('session menu', () => {
  const input = (patch: Partial<SessionMenuInput>): SessionMenuInput => ({
    mark: 'done',
    settled: false,
    backgroundTaskCount: 0,
    unavailable: null,
    supports: () => true,
    ...patch,
  })
  const byId = (items: ReturnType<typeof sessionMenuItems>) =>
    Object.fromEntries(items.map((item) => [item.id, item.disabledReason]))

  it('offers rename, naming and settling for a finished session', () => {
    const items = sessionMenuItems(input({}))
    expect(items.map((item) => item.id)).toEqual([
      'rename',
      'regenerate-title',
      'settle',
      'session-settings',
    ])
    expect(byId(items)).toMatchObject({
      rename: null,
      'regenerate-title': null,
      settle: null,
      'session-settings': 'Not on the phone yet',
    })
  })

  it('will not settle live work, and offers to stop background work', () => {
    expect(byId(sessionMenuItems(input({ mark: 'working' }))).settle).toBe(
      'Live work cannot be settled',
    )
    const background = sessionMenuItems(input({ mark: 'background', backgroundTaskCount: 2 }))
    const stop = background.find((item) => item.id === 'stop-background')
    expect(stop).toMatchObject({ disabledReason: null, destructive: true })
  })

  it('moves a settled session back to active', () => {
    const ids = sessionMenuItems(input({ settled: true })).map((item) => item.id)
    expect(ids).toContain('unsettle')
    expect(ids).not.toContain('settle')
  })

  it('says why when the environment cannot do it or cannot be reached', () => {
    const unsupported = byId(
      sessionMenuItems(input({ supports: (command) => command !== 'regenerateSessionTitle' })),
    )
    expect(unsupported['regenerate-title']).toBe('This environment cannot name sessions')
    expect(unsupported.rename).toBeNull()
    const offline = sessionMenuItems(input({ unavailable: 'Not connected to its environment' }))
    expect(offline.every((item) => item.disabledReason !== null)).toBe(true)
  })
})
