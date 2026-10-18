import { ABSENT, type DiffEntry } from './normalize.ts'
import { is, matches, type DiffCause, type DiffMatcher } from './evidence.ts'

/**
 * The documented reasons today's `main` violates the convergence property,
 * each as the diff entries it produces. Scenarios demonstrate one cause each;
 * the seeded runs use the catalog to tell a known divergence from a new one.
 * A later phase that fixes a cause deletes it here, and every run that still
 * shows it then fails.
 */

const ID = '[^.\\[\\]]+'
const THREAD = `active\\.threads\\.${ID}`
const re = (source: string) => new RegExp(`^${source}$`)

const absent = is(ABSENT)
const present = (value: unknown) => value !== ABSENT
const open = (value: unknown) => value === 'running' || value === 'waiting'

/** §3.6 row 1 (W2 family): `closeReasoning` settles thoughts the server rows keep open. */
export const THOUGHT_CLOSED_BY_FOLD: DiffCause = {
  cause:
    'The client fold closes a thought when text, a tool update or the turn end follows it ' +
    '(foldProtocolEvent.ts:80-86, :137, :169-172, :211); the server row keeps phase "delta" ' +
    '(event-projection.ts:326-351). §3.6 row 1, S2.',
  explains: [
    { path: re(`${THREAD}\\.reasoning\\.${ID}\\.phase`), left: is('stop'), right: is('delta') },
  ],
  requires: [
    {
      comparison: 'fresh',
      path: re(`${THREAD}\\.reasoning\\.${ID}\\.phase`),
      left: is('stop'),
      right: is('delta'),
    },
  ],
}

/** W1: restart recovery rewrites rows in SQL and writes no events. */
export const SILENT_RECOVERY: DiffCause = {
  cause:
    'recoverInterruptedTurns rewrites turns, interactions and sessions in SQL on boot ' +
    '(database.ts:42-105) and writes no event, so the replay from the pre-crash cursor is ' +
    'empty and the client keeps the turn open with its question pending. W1, S1. (The session ' +
    'status the doc also names is put right on main by the catalog read every reconnect makes.)',
  explains: [
    { path: re(`${THREAD}\\.turns\\[${ID}\\]\\.state`), left: open, right: is('interrupted') },
    { path: re(`${THREAD}\\.turns\\[${ID}\\]\\.finishedAt`), left: absent, right: present },
    { path: re(`${THREAD}\\.interactions\\.${ID}`), left: present, right: absent },
  ],
  requires: [
    {
      comparison: 'fresh',
      path: re(`${THREAD}\\.turns\\[${ID}\\]\\.state`),
      left: open,
      right: is('interrupted'),
    },
    {
      comparison: 'fresh',
      path: re(`${THREAD}\\.interactions\\.${ID}`),
      left: present,
      right: absent,
    },
  ],
}

/** W2: a snapshot over held history keeps older messages but replaces reasoning and tools. */
export const SNAPSHOT_MERGE_DROPS_OLDER_ACTIVITY: DiffCause = {
  cause:
    'applySnapshot keeps older messages it holds (state.ts:572, :616-622) and the history ' +
    'cursor (:588-594), rebuilds their order from messages alone (:584-587) and replaces ' +
    'reasoning and tools with the newest page’s (:595-596). Older thoughts and tools are gone ' +
    'and, with the cursor kept at null, never come back. W2, S4, S10.',
  explains: [
    { path: re(`${THREAD}\\.reasoning\\.${ID}`), left: absent, right: present },
    { path: re(`${THREAD}\\.tools\\.${ID}`), left: absent, right: present },
    { path: re(`${THREAD}\\.order\\[(reasoning|tool):${ID}\\]`), left: absent, right: present },
  ],
  requires: [
    {
      comparison: 'fresh',
      path: re(`${THREAD}\\.reasoning\\.${ID}`),
      left: absent,
      right: present,
    },
    { comparison: 'fresh', path: re(`${THREAD}\\.tools\\.${ID}`), left: absent, right: present },
    {
      comparison: 'fresh',
      path: re(`${THREAD}\\.order\\[(reasoning|tool):${ID}\\]`),
      left: absent,
      right: present,
    },
  ],
}

const NOT_LOADED = /^\[\d+ characters of thinking not loaded\]/

/** §7.1: the 384 KiB reasoning budget puts a marker in what a fresh load shows. */
export const REASONING_BUDGET_MARKER: DiffCause = {
  cause:
    'Snapshots and history pages cap reasoning text at 384 KiB and replace the rest with a ' +
    '"not loaded" note (session-store.ts:379-418, applied at :306); the client that streamed ' +
    'the thought holds all of it. §7.1, S6(b).',
  explains: [
    {
      path: re(`${THREAD}\\.reasoning\\.${ID}\\.content\\[0\\]\\.text`),
      right: (value) => typeof value === 'string' && NOT_LOADED.test(value),
    },
  ],
  requires: [
    {
      comparison: 'fresh',
      path: re(`${THREAD}\\.reasoning\\.${ID}\\.content\\[0\\]\\.text`),
      right: (value) => typeof value === 'string' && NOT_LOADED.test(value),
    },
  ],
}

/** §4.4: `persistRuntimeSession` stamps `updated_at` after `session.created` committed. */
export const RUNTIME_STAMP: DiffCause = {
  cause:
    'persistRuntimeSession writes updated_at once the provider session resolves ' +
    '(thread-service.ts:419-426, called at :1833), after session.created committed, with no ' +
    'event; the other client keeps the event time and sorts the sidebar by it. §4.4, S8.',
  explains: [
    { comparison: 'fresh', path: re(`sessions\\[${ID}\\]\\.updatedAt`) },
    { comparison: 'fresh', path: re('sessions\\(order\\)') },
    { comparison: 'fresh', path: re(`workspaces\\.${ID}\\.lastActivityAt`) },
  ],
  requires: [{ comparison: 'fresh', path: re(`sessions\\[${ID}\\]\\.updatedAt`) }],
}

/** W2 for the sidebar: the environment snapshot only upserts; reconciliation gives up. */
export const ENVIRONMENT_SNAPSHOT_NEVER_REMOVES: DiffCause = {
  cause:
    'A gap_expired environment snapshot only upserts sessions (state.ts:549-557), and ' +
    'reconcileCachedSessions drops nothing when none of its three passes fits on one page ' +
    '(websocket.ts:946-1004, :977-993), so sessions deleted during the gap stay listed. ' +
    '§3.6 rows 19 and 23, S9.',
  explains: [
    { comparison: 'fresh', path: re(`sessions\\[${ID}\\]`), left: present, right: absent },
  ],
  requires: [
    { comparison: 'fresh', path: re(`sessions\\[${ID}\\]`), left: present, right: absent },
  ],
}

/** §3.6 row 3: a turn's failure text lives only in the live event. */
export const FAILURE_ONLY_LIVE: DiffCause = {
  cause:
    'turn.failed’s reason and message live only in the client fold’s failures list ' +
    '(foldProtocolEvent.ts:139-146); no snapshot, history page or row carries them ' +
    '(state.ts:574). §3.6 row 3.',
  explains: [{ path: re(`${THREAD}\\.failures\\.${ID}`), left: present, right: absent }],
  requires: [
    { comparison: 'fresh', path: re(`${THREAD}\\.failures\\.${ID}`), left: present, right: absent },
  ],
}

/**
 * §3.6 row 14 and §4.4: a workspace's `lastActivityAt` is MAX(sessions.updated_at)
 * at read time (workspaces.ts:151, :238-241). The client moves its copy only on
 * session.created and turn events (state.ts:253-270, called at :413, :495, :882),
 * so a title or status change moves the server's value with no event at all.
 * Not one of the §8.4 scenarios; it shows wherever a session's last change was not a turn event.
 */
export const WORKSPACE_RECENCY_MIRROR: DiffCause = {
  cause:
    'lastActivityAt is computed from MAX(sessions.updated_at) when read (workspaces.ts:151, ' +
    ':238-241) and changes with no workspace event; the client mirrors it only on session.created ' +
    'and turn events (state.ts:253-270). §3.6 row 14, §4.4 (workspace recency).',
  explains: [
    {
      comparison: 'fresh',
      path: re(`workspaces\\.${ID}\\.lastActivityAt`),
      // The client's copy is behind: it never saw the change that moved it.
      pair: (left, right) =>
        typeof right === 'string' &&
        (left === null || (typeof left === 'string' && Date.parse(left) < Date.parse(right))),
    },
  ],
  requires: [{ comparison: 'fresh', path: re(`workspaces\\.${ID}\\.lastActivityAt`) }],
}

/**
 * §6.3: session.created carries a bare `Session` (no provider, status or
 * times), so a client that hears of a session only through the event lacks
 * its provider until it lists sessions again. F5 makes the payload a
 * SessionSummary. Not one of the §8.4 scenarios; it shows on every second client.
 */
export const SESSION_CREATED_PARTIAL: DiffCause = {
  cause:
    'session.created carries a bare Session (events.ts session.created; thread-service.ts:590-605), ' +
    'so a client that only heard the event has no providerId until a listing; §6.3 makes it a ' +
    'SessionSummary in F5.',
  explains: [
    {
      comparison: 'fresh',
      path: re(`sessions\\[${ID}\\]\\.providerId`),
      left: absent,
      right: present,
    },
  ],
  requires: [
    {
      comparison: 'fresh',
      path: re(`sessions\\[${ID}\\]\\.providerId`),
      left: absent,
      right: present,
    },
  ],
}

export const KNOWN_CAUSES: Record<string, DiffCause> = {
  WORKSPACE_RECENCY_MIRROR,
  SESSION_CREATED_PARTIAL,
  THOUGHT_CLOSED_BY_FOLD,
  SILENT_RECOVERY,
  SNAPSHOT_MERGE_DROPS_OLDER_ACTIVITY,
  REASONING_BUDGET_MARKER,
  RUNTIME_STAMP,
  ENVIRONMENT_SNAPSHOT_NEVER_REMOVES,
  FAILURE_ONLY_LIVE,
}

/** Each entry with the known causes that explain it; `[]` is a divergence nobody documented. */
export function classify(entries: readonly DiffEntry[]) {
  return entries.map((entry) => ({
    entry,
    causes: Object.entries(KNOWN_CAUSES)
      .filter(([, cause]) => cause.explains.some((matcher: DiffMatcher) => matches(matcher, entry)))
      .map(([name]) => name),
  }))
}
