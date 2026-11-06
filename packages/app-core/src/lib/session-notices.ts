// Which session status changes are worth interrupting someone for. Web raises
// them as browser notifications, the phone as Android ones; both read the
// statuses the sidebar shows (`groupSidebarSessions`).

export type SessionNotice = 'done' | 'waiting' | 'error'

const BUSY = new Set(['running', 'busy'])

/**
 * What a status change means to someone not looking: a turn that ended, one
 * that stopped for input, or one that failed. Anything else — first sight of
 * a session, starting work, being opened — says nothing.
 */
export function sessionNotice(previous: string | undefined, next: string): SessionNotice | null {
  if (previous === undefined || previous === next) return null
  if (next === 'waiting') return 'waiting'
  if (!BUSY.has(previous)) return null
  // `ready` too: a session on screen in a visible tab is acknowledged the
  // moment it finishes, so `done` can be skipped on its way to `ready`.
  if (next === 'done' || next === 'ready') return 'done'
  if (next === 'error') return 'error'
  return null
}

const NOTICE_BODY: Record<SessionNotice, string> = {
  done: 'Finished',
  waiting: 'Needs your input',
  error: 'Stopped with an error',
}

/** A question says so; any other wait is input in general. */
export function noticeBody(notice: SessionNotice, waitingOn?: string): string {
  if (notice === 'waiting' && waitingOn === 'question') return 'Has a question for you'
  return NOTICE_BODY[notice]
}
