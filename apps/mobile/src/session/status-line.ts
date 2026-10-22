/**
 * The line above the dock: what the session is doing, as the environment
 * lists it, and how long it has been at it, from the environment's own
 * timestamps. Pure, so the page's selector and the tests share it.
 *
 * Nothing here decides a state. The state is the listed session's status
 * and detail, read through the web sidebar's mapping (`statusMarkOf`); the
 * thread only lends the times the server stamped: when the open turn
 * started, when the pending request was asked, when the last turn ended.
 * When the server stamped none, the line has no time.
 */
import type { ThreadState } from '@openmanager/environment-client'

import { statusLineOf, statusMarkOf, type HomeSession, type StatusMark } from '../home/rows'

/** What the time on the right counts. */
export type StatusClockKind = 'elapsed' | 'waiting' | 'ago'

export interface StatusClock {
  kind: StatusClockKind
  /** Epoch ms of the server timestamp it counts from. */
  since: number
}

export interface StatusLineView {
  mark: Exclude<StatusMark, 'idle'>
  label: string
  /** Why it failed, in the environment's words, when it says. */
  detail: string | null
  clock: StatusClock | null
}

type ThreadTimes = Pick<ThreadState, 'turns' | 'interactions' | 'failures'>

const OPEN_TURN = new Set(['running', 'waiting'])

function ms(at: string | undefined | null): number | null {
  if (!at) return null
  const value = Date.parse(at)
  return Number.isFinite(value) ? value : null
}

/** The time the line counts from for `mark`, from `thread`'s server stamps. */
export function statusClockOf(
  mark: StatusMark,
  thread: ThreadTimes | null | undefined,
): StatusClock | null {
  if (!thread) return null
  switch (mark) {
    case 'working': {
      // The newest turn still open: the one the session is working on.
      const open = [...thread.turns].reverse().find((turn) => OPEN_TURN.has(turn.state))
      const since = ms(open?.startedAt)
      return since === null ? null : { kind: 'elapsed', since }
    }
    case 'needs':
    case 'question': {
      // The newest request the environment is still waiting on.
      let since: number | null = null
      for (const pending of thread.interactions) {
        const lifecycle = pending.interaction.lifecycle
        if (lifecycle && lifecycle.state !== 'pending') continue
        const asked = ms(lifecycle?.createdAt)
        if (asked !== null && (since === null || asked > since)) since = asked
      }
      return since === null ? null : { kind: 'waiting', since }
    }
    case 'done':
    case 'error': {
      const last = thread.turns[thread.turns.length - 1]
      const since = ms(last?.finishedAt)
      return since === null ? null : { kind: 'ago', since }
    }
    default:
      return null
  }
}

/** The failure of the session's last turn, when the environment reported one. */
export function failureDetailOf(thread: ThreadTimes | null | undefined): string | null {
  if (!thread) return null
  const last = thread.turns[thread.turns.length - 1]
  if (!last) return null
  return thread.failures.find((failure) => failure.turnId === last.turnId)?.message ?? null
}

/**
 * The status line for a listed session, or null at rest. `thread` is the
 * session's own thread when it is the one on screen.
 */
export function statusLineView(
  session: HomeSession | undefined,
  thread: ThreadTimes | null | undefined,
): StatusLineView | null {
  if (!session) return null
  const mark = statusMarkOf(session)
  const label = statusLineOf(session)
  if (mark === 'idle' || !label) return null
  return {
    mark,
    label,
    detail: mark === 'error' ? failureDetailOf(thread) : null,
    clock: statusClockOf(mark, thread),
  }
}

/** A stable string for a clock, so a selector can hand it out without a new object per event. */
export function clockKey(clock: StatusClock | null): string {
  return clock ? `${clock.kind}:${clock.since}` : ''
}

export function clockFromKey(key: string): StatusClock | null {
  const [kind, since] = key.split(':')
  const at = Number(since)
  if ((kind === 'elapsed' || kind === 'waiting' || kind === 'ago') && Number.isFinite(at)) {
    return { kind, since: at }
  }
  return null
}

/** "12s", "2m 10s", "1h 4m": a duration as the line shows it. */
export function formatElapsed(durationMs: number): string {
  const total = Math.max(0, Math.floor(durationMs / 1000))
  if (total < 60) return `${total}s`
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
}

/** "waiting 2m": whole minutes once past one, seconds before. */
function formatWaiting(durationMs: number): string {
  const total = Math.max(0, Math.floor(durationMs / 1000))
  if (total < 60) return `waiting ${total}s`
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  return hours > 0 ? `waiting ${hours}h ${minutes}m` : `waiting ${minutes}m`
}

function formatAgo(durationMs: number): string {
  const total = Math.max(0, Math.floor(durationMs / 1000))
  if (total < 45) return 'just now'
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${Math.max(1, minutes)}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/**
 * The clock's text at `now`. A phone clock behind the server's reads as zero,
 * never as a negative time.
 */
export function formatClock(clock: StatusClock, now: number): string {
  const duration = Math.max(0, now - clock.since)
  switch (clock.kind) {
    case 'elapsed':
      return formatElapsed(duration)
    case 'waiting':
      return formatWaiting(duration)
    default:
      return formatAgo(duration)
  }
}

/** How often the clock's text can change: every second while counting, every half minute for an age. */
export function clockTickMs(clock: StatusClock): number {
  return clock.kind === 'ago' ? 30_000 : 1000
}
