import { useCallback } from 'react'
import { ArrowUpRightIcon, LockSimpleIcon } from '@phosphor-icons/react'
import { isSettledSubagentStatus, type Subagent, type Turn } from '@openmanager/protocol'
import {
  selectSubagentOfSession,
  type EnvironmentState,
  type SessionSummary,
} from '@openmanager/environment-client'
import { cn } from '../../lib/utils'
import { useEnvironmentState } from '../../providers/environment-client'
import { useSessionState } from '../../providers/session-provider'
import { ProviderIcon } from '../providers/ProviderIcon'
import type { ProviderIconId } from '../providers/providerIconId'
import { subagentStatusColor, useTick } from '../parts/SubagentCard'
import {
  formatElapsed,
  providerName,
  subagentElapsedMs,
  subagentModelLabel,
  subagentStatusLabel,
  subagentTone,
} from '../parts/subagent-card'

/**
 * Who a child session is, as its page shows it: from the subagent's record
 * when the parent's thread is held, else from what the child's own summary
 * says (its status, provider and model).
 */
export interface SubagentIdentity {
  title: string
  agentType?: string
  providerId: string
  model?: string
  status: Subagent['status']
  waitingOn?: Subagent['waitingOn']
  /** When it started and how it stands, for the clock; absent without the record. */
  record?: Pick<Subagent, 'status' | 'stats' | 'startedAt' | 'finishedAt'>
}

/** How the child's own last turn ended, in the record's terms. */
const STATUS_FROM_TURN: Partial<Record<Turn['state'], Subagent['status']>> = {
  completed: 'completed',
  failed: 'failed',
  interrupted: 'interrupted',
}

/**
 * Where the subagent stands, from what the child page holds live: the
 * child's own session status and its last turn. The parent's record stops
 * updating once the parent's thread is let go (opening the child does), so
 * it is believed only where these say nothing.
 */
export function liveSubagentStatus(
  child: Pick<SessionSummary, 'status' | 'waitingOn'>,
  lastTurn: Turn['state'] | undefined,
  record: Subagent | null,
): Pick<SubagentIdentity, 'status' | 'waitingOn'> {
  if (child.status === 'waiting') {
    return { status: 'waiting', ...(child.waitingOn ? { waitingOn: child.waitingOn } : {}) }
  }
  if (child.status === 'running') return { status: 'running' }
  if (child.status === 'error') return { status: 'failed' }
  const ended = lastTurn ? STATUS_FROM_TURN[lastTurn] : undefined
  // A stopped subagent's turn reads `interrupted`; its record says `cancelled`.
  if (ended === 'interrupted' && record?.status === 'cancelled') return { status: 'cancelled' }
  if (ended) return { status: ended }
  if (record && isSettledSubagentStatus(record.status)) return { status: record.status }
  // Idle, with neither its turns nor a settled record to say how it ended.
  return { status: record?.status === 'pending' ? 'pending' : 'interrupted' }
}

export function subagentIdentity(
  child: Pick<SessionSummary, 'title' | 'providerId' | 'status' | 'waitingOn' | 'composer'>,
  record: Subagent | null,
  lastTurn?: Turn['state'],
): SubagentIdentity {
  const live = liveSubagentStatus(child, lastTurn, record)
  if (record) {
    const model = subagentModelLabel(record.modelId ?? child.composer?.modelId)
    return {
      title: record.title || child.title || 'Subagent',
      ...(record.agentType ? { agentType: record.agentType } : {}),
      providerId: record.providerId,
      ...(model ? { model } : {}),
      ...live,
      record: { ...record, status: live.status },
    }
  }
  const model = subagentModelLabel(child.composer?.modelId)
  return {
    title: child.title || 'Subagent',
    providerId: child.providerId,
    ...(model ? { model } : {}),
    ...live,
  }
}

/**
 * What the subagent runs on and how it stands, at the foot of its page: the
 * model, then its status and how long it ran, ticking while it runs.
 */
export function SubagentStatusLine({
  identity,
  className,
}: {
  identity: SubagentIdentity
  className?: string
}) {
  const tone = subagentTone(identity.status)
  const now = useTick(tone === 'running' || tone === 'waiting')
  const elapsed = identity.record ? subagentElapsedMs(identity.record, now) : undefined
  // Done needs no colour here; what still needs someone, or went wrong, does.
  const color = tone === 'done' ? undefined : subagentStatusColor(identity)
  return (
    <span
      className={cn(
        'flex min-w-0 items-center gap-1.5 tabular-nums text-[var(--basis-text-faint)]',
        className,
      )}
      data-subagent-status-line
    >
      <ProviderIcon
        providerId={identity.providerId as ProviderIconId}
        className="size-3 shrink-0 opacity-90"
      />
      <span className="min-w-0 max-w-[12rem] truncate">
        {identity.model ?? providerName(identity.providerId)}
      </span>
      <span aria-hidden>·</span>
      <span
        className={cn('shrink-0', tone === 'running' && 'text-[var(--basis-text-muted)]')}
        style={color ? { color } : undefined}
      >
        {subagentStatusLabel(identity)}
        {elapsed !== undefined ? ` ${formatElapsed(elapsed)}` : ''}
      </span>
    </span>
  )
}

/**
 * In place of the composer on a subagent only its parent agent can reach.
 * Quiet, since there is nothing wrong: it says why, what the subagent runs on
 * and how it stands, and offers the way back.
 */
export function SubagentReadOnlyFooter({
  parentTitle,
  identity,
  onOpenParent,
}: {
  parentTitle?: string
  identity?: SubagentIdentity
  onOpenParent?: () => void
}) {
  return (
    <div
      role="note"
      className="mb-1 flex h-9 min-w-0 items-center gap-2.5 rounded-[10px] bg-[var(--basis-surface)] pr-1.5 pl-3 text-ui-sm leading-[18px] text-[var(--basis-text-muted)]"
    >
      <LockSimpleIcon size={13} aria-hidden className="shrink-0 text-[var(--basis-text-faint)]" />
      <span
        className="min-w-0 flex-1 truncate"
        title="Only the parent agent can message this subagent. To follow up, ask it to relay your message."
      >
        Only the parent agent can message this subagent.
      </span>
      {identity ? <SubagentStatusLine identity={identity} className="shrink-0" /> : null}
      {onOpenParent ? (
        <button
          type="button"
          onClick={onOpenParent}
          className="flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md px-2 text-[var(--basis-text)] transition-colors hover:bg-[var(--basis-surface-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
          title={parentTitle ? `Open ${parentTitle}` : 'Open the parent session'}
        >
          Open parent
          <ArrowUpRightIcon size={11} aria-hidden />
        </button>
      ) : null}
    </div>
  )
}

/** What the open session's page knows about it as a child: null for a top-level session. */
export interface ChildSessionView {
  parentSessionId: string
  parentTitle: string
  /** A person can send it messages. False for Claude and Cursor subagents. */
  promptable: boolean
  identity: SubagentIdentity
}

const sameFields = <T extends object>(left: T, right: T) => {
  const keys = Object.keys(left) as (keyof T)[]
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key])
}

/** Field by field; the record compares by identity, which the store keeps while it is unchanged. */
const sameView = (left: ChildSessionView | null, right: ChildSessionView | null) =>
  left === right ||
  (left !== null &&
    right !== null &&
    left.parentSessionId === right.parentSessionId &&
    left.parentTitle === right.parentTitle &&
    left.promptable === right.promptable &&
    sameFields(left.identity, right.identity))

/** The open session as a child, read from the environment. */
export function useChildSessionView(): ChildSessionView | null {
  return useEnvironmentState(
    useCallback((state: EnvironmentState): ChildSessionView | null => {
      const child = state.activeSessionId ? state.sessions[state.activeSessionId] : undefined
      if (!child?.parentSessionId) return null
      const parent = state.sessions[child.parentSessionId]
      const record = selectSubagentOfSession(state, child.sessionId)
      const lastTurn = child.threadIds
        .map((threadId) => state.threads[threadId]?.turns.at(-1)?.state)
        .find((turnState) => turnState !== undefined)
      return {
        parentSessionId: child.parentSessionId,
        parentTitle: parent?.title || 'Parent session',
        // An older environment says nothing: its children were transcripts only.
        promptable: child.subagent?.promptable ?? record?.promptable ?? false,
        identity: subagentIdentity(child, record, lastTurn),
      }
    }, []),
    sameView,
  )
}

/**
 * The open session's place in the title bar's trail when it is a child: the
 * parent to go back to, and the subagent's kind to set beside its title.
 * Null on a top-level session. Needs an environment client.
 */
export interface ChildSessionTrail {
  parentTitle: string
  agentType?: string
  openParent: () => void
}

export function useChildSessionTrail(): ChildSessionTrail | null {
  const child = useChildSessionView()
  const { closeChildSession } = useSessionState()
  if (!child) return null
  const agentType = child.identity.agentType
  return {
    parentTitle: child.parentTitle,
    ...(agentType && agentType !== child.identity.title ? { agentType } : {}),
    openParent: () => closeChildSession(child.parentSessionId),
  }
}
