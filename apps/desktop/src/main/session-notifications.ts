import { basename } from 'node:path'
import { app, Notification, type BrowserWindow } from 'electron'
import type { AgentEvent, ProviderId } from '@agentpack/contract'
import { providers } from '@agentpack/runtime'
import type { SessionNotificationTarget } from '../shared/session-notification'

/** How much of a prompt or tool title a toast can carry before the platform
 * truncates it for us — better to cut on a boundary we chose. */
const LABEL_MAX_LENGTH = 60

/** Threads the desktop opens for its own bookkeeping rather than for a user's
 * conversation: the launch probe and the `session/list` refresher. They never
 * prompt, but they do share the event pipeline, and a toast about one would be
 * meaningless. */
const PSEUDO_THREAD_PREFIXES = ['desktop-bootstrap:', 'session-metadata:']

/** Stop reasons that mean the turn ended because the *user* ended it. They are
 * already at the keyboard, so a "turn finished" toast is pure noise. Matches
 * the normalization in `ConvexProjector`. */
const USER_ENDED_TURN = /cancel|abort|interrupt/i

export type SessionNotificationContent = {
  title: string
  body: string
}

function isPseudoThread(threadId: string): boolean {
  return PSEUDO_THREAD_PREFIXES.some((prefix) => threadId.startsWith(prefix))
}

function truncate(value: string): string {
  const singleLine = value.replace(/\s+/g, ' ').trim()
  if (singleLine.length <= LABEL_MAX_LENGTH) return singleLine
  return `${singleLine.slice(0, LABEL_MAX_LENGTH - 1)}…`
}

function providerDisplayName(providerId: ProviderId): string {
  return providers[providerId]?.displayName ?? providerId
}

/** The headline detail for each moment the user has to act on — the thing they
 * would have had to open the window to read. */
function detailFor(event: AgentEvent): string | undefined {
  switch (event.event) {
    case 'permission_request':
      return event.data.toolCall.title || event.data.toolCall.kind
    case 'question_request':
      return event.data.title || event.data.questions[0]?.prompt
    case 'plan_review_request':
      return event.data.name || event.data.overview
    default:
      return undefined
  }
}

function subjectFor(event: AgentEvent): string | undefined {
  switch (event.event) {
    case 'permission_request':
      return 'Permission needed'
    case 'question_request':
      return 'Question for you'
    case 'plan_review_request':
      return 'Plan ready for review'
    case 'prompt_completed':
      return USER_ENDED_TURN.test(event.data.stopReason ?? '') ? undefined : 'Turn finished'
    default:
      return undefined
  }
}

/** Toast text for an event, or `null` when this event is not one the user needs
 * to be pulled back for.
 *
 * Split out from the sending so the wording is testable without a display
 * server: everything below this line touches Electron, everything above is a
 * pure function of the event plus the session's remembered label.
 *
 * `sessionLabel` is what the user calls this conversation — the provider's own
 * session title when it has offered one, otherwise a summary of the prompt that
 * started the turn. */
export function describeSessionEvent(
  event: AgentEvent,
  sessionLabel?: string,
): SessionNotificationContent | null {
  if (isPseudoThread(event.threadId)) return null
  const subject = subjectFor(event)
  if (!subject) return null

  const workspaceName = event.workspaceId ? basename(event.workspaceId) : undefined
  const detail = detailFor(event)
  // The label repeats the detail whenever a question's title is also the
  // session title; two identical lines read like a rendering bug.
  const lines = [detail, sessionLabel]
    .map((line) => (line ? truncate(line) : undefined))
    .filter((line, index, all): line is string => Boolean(line) && all.indexOf(line) === index)

  return {
    title: workspaceName ? `${subject} · ${workspaceName}` : subject,
    body: lines.length > 0 ? lines.join('\n') : providerDisplayName(event.providerId),
  }
}

export type SessionNotifierOptions = {
  getWindow: () => BrowserWindow | null
}

/** Raises a desktop notification whenever a session starts waiting on the user
 * — a permission prompt, a question, a plan review — or finishes its turn.
 *
 * Driven from `AgentHost.emitEvent`, which is the one place every session's
 * events pass through, so a background session's prompt notifies exactly like
 * the one on screen. The renderer could not do this job: its permission and
 * question providers are Convex queries scoped to the *active* session, and the
 * whole point of a notification is that the user is somewhere else. */
export class SessionNotifier {
  /** threadId -> what to call this conversation in a toast. */
  private readonly labels = new Map<string, string>()

  constructor(private readonly options: SessionNotifierOptions) {}

  /** Record a provider-supplied session title. Last write wins against the
   * prompt-derived label, in both directions: whichever description of the
   * session arrived most recently is the one that describes it now. */
  noteSessionTitle(threadId: string, title: string): void {
    const trimmed = title.trim()
    if (trimmed) this.labels.set(threadId, trimmed)
  }

  handle(event: AgentEvent): void {
    if (isPseudoThread(event.threadId)) return
    if (event.event === 'prompt_started') {
      this.noteSessionTitle(event.threadId, event.data.prompt)
      return
    }
    if (event.event === 'session_deleted') {
      this.labels.delete(event.threadId)
      return
    }

    const content = describeSessionEvent(event, this.labels.get(event.threadId))
    if (!content || !Notification.isSupported()) return
    // Every notifying event carries a sessionId; the cast keeps the union
    // narrow at the one place the target is built.
    const sessionId = (event as AgentEvent & { sessionId?: string }).sessionId
    if (!sessionId) return

    const notification = new Notification(content)
    notification.on('click', () =>
      this.activate({
        providerId: event.providerId,
        sessionId,
        ...(event.workspaceId ? { workspacePath: event.workspaceId } : {}),
      }),
    )
    notification.show()
  }

  /** Bring the window forward and put the notified session on screen. */
  private activate(target: SessionNotificationTarget): void {
    const window = this.options.getWindow()
    if (!window || window.isDestroyed()) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
    // On macOS focusing a window of a background app does not bring the app
    // itself forward; on Windows and Linux `show()` already has.
    if (process.platform === 'darwin') app.focus({ steal: true })
    window.webContents.send('notification:activate', target)
  }
}
