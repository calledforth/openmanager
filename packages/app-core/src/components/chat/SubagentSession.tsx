import { useCallback, useEffect, useState } from 'react'
import { ArrowLeftIcon, ArrowUpRightIcon, LockSimpleIcon } from '@phosphor-icons/react'
import type { Subagent } from '@openmanager/protocol'
import {
  selectSubagentOfSession,
  type EnvironmentState,
  type SessionSummary,
} from '@openmanager/environment-client'
import { cn } from '../../lib/utils'
import { useEnvironmentState } from '../../providers/environment-client'
import { ProviderIcon } from '../providers/ProviderIcon'
import type { ProviderIconId } from '../providers/providerIconId'
import { SubagentStatusGlyph } from '../parts/SubagentCard'
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
  background?: boolean
  /** When it started and how it stands, for the clock; absent without the record. */
  record?: Pick<Subagent, 'status' | 'stats' | 'startedAt' | 'finishedAt'>
}

const STATUS_FROM_SESSION: Record<string, Subagent['status']> = {
  running: 'running',
  waiting: 'waiting',
  error: 'failed',
  idle: 'completed',
}

export function subagentIdentity(
  child: Pick<SessionSummary, 'title' | 'providerId' | 'status' | 'waitingOn' | 'composer'>,
  record: Subagent | null,
): SubagentIdentity {
  if (record) {
    return {
      title: record.title || child.title || 'Subagent',
      ...(record.agentType ? { agentType: record.agentType } : {}),
      providerId: record.providerId,
      ...(subagentModelLabel(record.modelId ?? child.composer?.modelId)
        ? { model: subagentModelLabel(record.modelId ?? child.composer?.modelId) }
        : {}),
      status: record.status,
      ...(record.waitingOn ? { waitingOn: record.waitingOn } : {}),
      ...(record.background ? { background: true } : {}),
      record,
    }
  }
  const model = subagentModelLabel(child.composer?.modelId)
  return {
    title: child.title || 'Subagent',
    providerId: child.providerId,
    ...(model ? { model } : {}),
    status: STATUS_FROM_SESSION[child.status] ?? 'completed',
    ...(child.waitingOn ? { waitingOn: child.waitingOn } : {}),
  }
}

function useTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

/**
 * The strip at the top of a subagent's page: the way back to the session that
 * started it, then who this is (status, name, kind) and what it runs on.
 */
export function SubagentSessionHeaderView({
  parentTitle,
  identity,
  onBack,
}: {
  parentTitle: string
  identity: SubagentIdentity
  onBack?: () => void
}) {
  const tone = subagentTone(identity.status)
  const live = tone === 'running' || tone === 'waiting'
  const now = useTick(live)
  const elapsed = identity.record ? subagentElapsedMs(identity.record, now) : undefined
  const statusColor =
    tone === 'waiting'
      ? identity.waitingOn === 'question'
        ? 'var(--basis-status-question)'
        : 'var(--basis-status-needs)'
      : tone === 'failed'
        ? 'var(--basis-status-error)'
        : undefined
  return (
    <div className="mx-auto w-full max-w-[48rem] shrink-0 px-4 pt-2" data-subagent-header>
      <div className="flex h-9 w-full min-w-0 items-center gap-2 rounded-[10px] bg-[var(--basis-surface)] pl-1 pr-3 text-ui-sm">
        <button
          type="button"
          onClick={onBack}
          disabled={!onBack}
          className="flex h-7 min-w-0 max-w-[40%] shrink cursor-pointer items-center gap-1.5 rounded-md px-2 text-[var(--basis-text-muted)] transition-colors hover:bg-[var(--basis-surface-hover)] hover:text-[var(--basis-text)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:hover:bg-transparent"
          title={`Back to ${parentTitle}`}
        >
          <ArrowLeftIcon size={12} aria-hidden className="shrink-0" />
          <span className="truncate">{parentTitle}</span>
        </button>
        <span aria-hidden className="shrink-0 text-[var(--basis-text-faint)]">
          /
        </span>
        <SubagentStatusGlyph subagent={identity} />
        <span className="min-w-0 truncate font-medium text-[var(--basis-text)]">
          {identity.title}
        </span>
        {identity.agentType && identity.agentType !== identity.title ? (
          <span className="inline-flex h-[18px] shrink-0 items-center rounded-[5px] bg-[var(--basis-surface-hover)] px-1.5 text-[11px] leading-none text-[var(--basis-text-muted)]">
            {identity.agentType}
          </span>
        ) : null}
        {identity.background ? (
          <span
            className="inline-flex h-[18px] shrink-0 items-center rounded-[5px] px-1.5 text-[11px] leading-none"
            style={{
              color: 'var(--basis-status-background)',
              background: 'color-mix(in srgb, var(--basis-status-background) 13%, transparent)',
            }}
          >
            Background
          </span>
        ) : null}
        <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2 text-[var(--basis-text-faint)]">
          <ProviderIcon providerId={identity.providerId as ProviderIconId} className="size-3" />
          <span className="max-w-[12rem] truncate">
            {identity.model ?? providerName(identity.providerId)}
          </span>
          <span aria-hidden>·</span>
          <span
            className={cn(tone === 'running' && 'text-[var(--basis-text-muted)]')}
            style={statusColor ? { color: statusColor } : undefined}
          >
            {subagentStatusLabel(identity)}
          </span>
          {elapsed !== undefined ? (
            <span className="tabular-nums">{formatElapsed(elapsed)}</span>
          ) : null}
        </span>
      </div>
    </div>
  )
}

/**
 * In place of the composer on a subagent only its parent agent can reach.
 * Quiet, since there is nothing wrong: it says why, and where to go instead.
 */
export function SubagentReadOnlyFooter({
  parentTitle,
  onOpenParent,
}: {
  parentTitle?: string
  onOpenParent?: () => void
}) {
  return (
    <div
      role="note"
      className="mb-1 flex min-w-0 items-center gap-2.5 rounded-[10px] bg-[var(--basis-surface)] py-2 pl-3 pr-2 text-ui-sm leading-[18px] text-[var(--basis-text-muted)]"
    >
      <LockSimpleIcon size={13} aria-hidden className="shrink-0 text-[var(--basis-text-faint)]" />
      <span className="min-w-0 flex-1">
        Only the parent agent can message this subagent.{' '}
        <span className="text-[var(--basis-text-faint)]">
          To follow up, ask it to relay your message.
        </span>
      </span>
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
      return {
        parentSessionId: child.parentSessionId,
        parentTitle: parent?.title || 'Parent session',
        // An older environment says nothing: its children were transcripts only.
        promptable: child.subagent?.promptable ?? record?.promptable ?? false,
        identity: subagentIdentity(child, record),
      }
    }, []),
    sameView,
  )
}
