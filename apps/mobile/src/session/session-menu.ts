/**
 * The session page's ⋯ menu, as items: what the reader can ask the
 * environment to do with the session, and, for each one it cannot do from
 * here, why. Pure, so the page and the tests share it. Nothing here changes
 * a session: every enabled item is a command the shared client sends, and
 * the page shows what the environment answers.
 */
import type { EnvironmentCommandName } from '@openmanager/environment-client'

import { canCook, canSettle, type StatusMark } from '../home/rows'

export type SessionMenuItemId =
  | 'cook'
  | 'uncook'
  | 'rename'
  | 'regenerate-title'
  | 'pin'
  | 'unpin'
  | 'settle'
  | 'unsettle'
  | 'stop-background'
  | 'session-settings'

export interface SessionMenuItem {
  id: SessionMenuItemId
  label: string
  /** The word under its tile in the actions sheet, where it is one of the three places. */
  short?: string
  /** Why it cannot be used from here; null when it can. */
  disabledReason: string | null
  /** Stops work the session is doing: drawn in the error tone. */
  destructive?: boolean
}

export interface SessionMenuInput {
  mark: StatusMark
  /** The reader settled it (it is in the long tail of All). */
  settled: boolean
  /** The reader pinned it to the top of Active. */
  pinned?: boolean
  /** The reader sent it cooking: out of the active list while it works. */
  cooking?: boolean
  /** Background tasks the environment lists for it. */
  backgroundTaskCount: number
  /** Kept running by background work, even when it shows as done beside it. */
  inBackground?: boolean
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

function gate(input: SessionMenuInput, command: EnvironmentCommandName, otherwise: string) {
  if (input.unavailable) return input.unavailable
  return input.supports(command) ? null : otherwise
}

export function sessionMenuItems(input: SessionMenuInput): SessionMenuItem[] {
  const items: SessionMenuItem[] = []
  // Where the session sits comes first: cooking, the pin, settled. As web's
  // card: anything can cook except a session that already needs the reader
  // (what would bring it back has happened), and one sent cooking can always
  // be brought back by hand. Settled wins over cooking, so a settled session
  // offers neither.
  if (!input.settled) {
    const reason = gate(input, 'cookSession', 'This environment cannot keep sessions cooking')
    if (input.cooking) {
      items.push({
        id: 'uncook',
        label: 'Bring back from Cooking',
        short: 'Bring back',
        disabledReason: reason,
      })
    } else if (canCook(input.mark)) {
      items.push({ id: 'cook', label: 'Send to Cooking', short: 'Cook', disabledReason: reason })
    }
  }
  // Any active session can be pinned, live ones too; a pinned one can always
  // be unpinned, wherever it is.
  if (input.pinned) {
    items.push({
      id: 'unpin',
      label: 'Unpin',
      short: 'Unpin',
      disabledReason: gate(input, 'pinSession', 'This environment cannot pin sessions'),
    })
  } else if (!input.settled && !input.cooking) {
    items.push({
      id: 'pin',
      label: 'Pin to top',
      short: 'Pin',
      disabledReason: gate(input, 'pinSession', 'This environment cannot pin sessions'),
    })
  }
  if (input.settled) {
    items.push({
      id: 'unsettle',
      label: 'Move back to active',
      short: 'Move back',
      disabledReason: gate(input, 'settleSession', 'This environment cannot settle sessions'),
    })
  } else {
    items.push({
      id: 'settle',
      label: 'Settle',
      short: 'Settle',
      disabledReason:
        gate(input, 'settleSession', 'This environment cannot settle sessions') ??
        (canSettle(input.mark, !!input.inBackground) ? null : 'Live work cannot be settled'),
    })
  }
  items.push(
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
  )
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

/** The three places a session can be put: the tiles at the top of the actions sheet. */
const PLACE_IDS: ReadonlySet<string> = new Set<SessionMenuItemId>([
  'cook',
  'uncook',
  'pin',
  'unpin',
  'settle',
  'unsettle',
])

export const isPlaceItem = (item: { id: string }) => PLACE_IDS.has(item.id)

/**
 * The menu as it is drawn, concise: what can be done, and nothing that
 * cannot. An item this session or this environment can never take (live
 * work to settle, a command the environment lacks, settings with no
 * composer) is left out rather than listed with an apology. What only waits
 * stays, dimmed: everything while nothing can be sent (`said`, stated once
 * above the items), and the others while a command is out.
 */
export function conciseMenu<Item extends { disabledReason: string | null }>(
  items: readonly Item[],
  said: string | null,
): Item[] {
  return items.filter(
    (item) =>
      item.disabledReason === null ||
      item.disabledReason === said ||
      item.disabledReason === PENDING_REASON,
  )
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
