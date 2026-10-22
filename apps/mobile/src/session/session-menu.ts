/**
 * The session page's ⋯ menu, as items: what the reader can ask the
 * environment to do with the session, and, for each one it cannot do from
 * here, why. Pure, so the page and the tests share it. Nothing here changes
 * a session: every enabled item is a command the shared client sends, and
 * the page shows what the environment answers.
 */
import type { EnvironmentCommandName } from '@openmanager/environment-client'

import type { StatusMark } from '../home/rows'

export type SessionMenuItemId =
  'rename' | 'regenerate-title' | 'settle' | 'unsettle' | 'stop-background' | 'session-settings'

export interface SessionMenuItem {
  id: SessionMenuItemId
  label: string
  /** Why it cannot be used from here; null when it can. */
  disabledReason: string | null
  /** Stops work the session is doing: drawn in the error tone. */
  destructive?: boolean
}

export interface SessionMenuInput {
  mark: StatusMark
  /** The reader settled it (it is in the long tail of All). */
  settled: boolean
  /** Background tasks the environment lists for it. */
  backgroundTaskCount: number
  /**
   * Why nothing can be sent right now (a sample session, the environment not
   * connected); null when commands can go.
   */
  unavailable: string | null
  supports: (command: EnvironmentCommandName) => boolean
  /**
   * Session settings: null when the composer can open them, else why not.
   * Left out where there is no composer (a sample session, nothing paired).
   */
  settings?: string | null
}

/** Live work cannot be settled: the environment refuses it, as web's sidebar says. */
const LIVE: ReadonlySet<StatusMark> = new Set(['working', 'background', 'needs', 'question'])

function gate(input: SessionMenuInput, command: EnvironmentCommandName, otherwise: string) {
  if (input.unavailable) return input.unavailable
  return input.supports(command) ? null : otherwise
}

export function sessionMenuItems(input: SessionMenuInput): SessionMenuItem[] {
  const items: SessionMenuItem[] = [
    {
      id: 'rename',
      label: 'Rename',
      disabledReason: gate(input, 'renameSession', 'This environment cannot rename sessions'),
    },
    {
      id: 'regenerate-title',
      label: 'Name it again',
      disabledReason: gate(
        input,
        'regenerateSessionTitle',
        'This environment cannot name sessions',
      ),
    },
  ]
  if (input.settled) {
    items.push({
      id: 'unsettle',
      label: 'Move back to active',
      disabledReason: gate(input, 'settleSession', 'This environment cannot settle sessions'),
    })
  } else {
    items.push({
      id: 'settle',
      label: 'Settle',
      disabledReason:
        gate(input, 'settleSession', 'This environment cannot settle sessions') ??
        (LIVE.has(input.mark) ? 'Live work cannot be settled' : null),
    })
  }
  if (input.mark === 'background' || input.backgroundTaskCount > 0) {
    items.push({
      id: 'stop-background',
      label: 'Stop background work',
      destructive: true,
      disabledReason: gate(
        input,
        'stopBackgroundTasks',
        'This environment cannot stop background work',
      ),
    })
  }
  // The provider's other settings, in the composer's sheet.
  items.push({
    id: 'session-settings',
    label: 'Session settings',
    disabledReason:
      input.unavailable ?? (input.settings === undefined ? 'Not on the phone yet' : input.settings),
  })
  return items
}

/** What a held item says while another command is out. */
export const PENDING_REASON = 'Waiting for the last change to land'

/**
 * The items while a command is out: every one that could be used waits for
 * it, so two answers never race for the line under the title.
 */
export function holdWhilePending(
  items: readonly SessionMenuItem[],
  pending: boolean,
): readonly SessionMenuItem[] {
  if (!pending) return items
  return items.map((item) =>
    item.disabledReason ? item : { ...item, disabledReason: PENDING_REASON },
  )
}
