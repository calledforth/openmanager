import { CaretLeftIcon, CaretRightIcon, XIcon } from '@phosphor-icons/react'
import type { PlanTodo, PlanTodoStatus } from '@agentpack/contract'
import { usePlanState, type PlanRow } from '../../providers/plan-provider'
import { TextPart } from '../parts/TextPart'
import {
  typographyBody,
  typographyCaption,
  typographyCaptionTiny,
  typographyLabel,
  typographyLabelSm,
} from '../../lib/typography'

const buildButtonClass = `rounded-[var(--basis-chat-shell-radius)] bg-[var(--basis-action-bg)] px-2.5 py-1 ${typographyLabelSm} text-[var(--basis-action-fg)] transition-colors hover:bg-[var(--basis-action-hover)]`

function StatusBadge({ status }: { status: string }) {
  const styles =
    status === 'accepted'
      ? 'border-transparent bg-[color-mix(in_srgb,#22c55e_18%,transparent)] text-[#22c55e]'
      : status === 'pending'
        ? 'border-transparent bg-[color-mix(in_srgb,#f59e0b_14%,transparent)] text-amber-500'
        : status === 'rejected'
          ? 'border-transparent bg-[color-mix(in_srgb,#f97316_12%,transparent)] text-orange-400'
          : 'border-[var(--basis-border-muted)] bg-[var(--basis-surface)] text-[var(--basis-text-faint)]'
  const label =
    status === 'pending' ? 'awaiting review' : status === 'rejected' ? 'changes requested' : status
  return (
    <span
      className={`shrink-0 rounded-full border px-2 py-0.5 ${typographyCaptionTiny} uppercase tracking-[0.1em] ${styles}`}
    >
      {label}
    </span>
  )
}

function TodoIcon({ status }: { status: PlanTodoStatus }) {
  if (status === 'completed') {
    return (
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0 text-[#22c55e]" aria-hidden="true">
        <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.25" />
        <path
          d="M4.5 8.2l2.2 2.2 4.8-4.8"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    )
  }
  if (status === 'in_progress') {
    return (
      <svg
        viewBox="0 0 16 16"
        className="h-3.5 w-3.5 shrink-0 text-[var(--basis-text)]"
        aria-hidden="true"
      >
        <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.25" />
        <circle cx="8" cy="8" r="3.25" fill="currentColor" />
      </svg>
    )
  }
  // pending / cancelled: empty circle (cancelled is dimmed by the row text below)
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-3.5 w-3.5 shrink-0 text-[var(--basis-text-faint)]"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.25" />
    </svg>
  )
}

function TodoChecklist({ todos }: { todos: PlanTodo[] }) {
  if (todos.length === 0) return null
  return (
    <ul className="flex flex-col gap-1">
      {todos.map((todo) => {
        const emphasized = todo.status === 'in_progress'
        const cancelled = todo.status === 'cancelled'
        return (
          <li key={todo.id} className="flex items-start gap-2">
            <span className="mt-0.5">
              <TodoIcon status={todo.status} />
            </span>
            <span
              className={`${typographyBody} ${
                emphasized
                  ? 'text-[var(--basis-text)]'
                  : cancelled
                    ? 'text-[var(--basis-text-faint)] line-through'
                    : 'text-[var(--basis-text-muted)]'
              }`}
            >
              {todo.content}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

function PlanBody({ plan }: { plan: PlanRow }) {
  return (
    <div className="flex flex-col gap-4">
      {plan.overview ? (
        <p className={`${typographyBody} text-[var(--basis-text-muted)]`}>{plan.overview}</p>
      ) : null}
      {plan.markdown ? <TextPart text={plan.markdown} /> : null}
      {plan.todos.length > 0 ? (
        <div className="flex flex-col gap-2">
          <div
            className={`${typographyCaptionTiny} uppercase tracking-[0.12em] text-[var(--basis-text-faint)]`}
          >
            Todos
          </div>
          <TodoChecklist todos={plan.todos} />
        </div>
      ) : null}
      {plan.phases?.map((phase, index) => (
        <div key={`${phase.name}:${index}`} className="flex flex-col gap-2">
          <div className={`${typographyLabelSm} text-[var(--basis-text)]`}>{phase.name}</div>
          <TodoChecklist todos={phase.todos} />
        </div>
      ))}
      {plan.resolutionReason ? (
        <div className="rounded-[var(--basis-chat-shell-radius)] border border-orange-500/20 bg-orange-500/[0.06] px-3 py-2.5">
          <div className={`${typographyCaptionTiny} uppercase tracking-[0.12em] text-orange-400`}>
            Requested changes
          </div>
          <p className={`mt-1 ${typographyBody} text-[var(--basis-text-muted)]`}>
            {plan.resolutionReason}
          </p>
        </div>
      ) : null}
    </div>
  )
}

function revisionTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(timestamp)
}

/** Right-side panel that renders the pending (or latest) plan document in full. */
export function PlanPanel() {
  const {
    isPanelOpen,
    closePanel,
    pendingPlan,
    planHistory,
    selectedPlan,
    selectPlan,
    buildPendingPlan,
    isBuilding,
  } = usePlanState()
  if (!isPanelOpen) return null

  const revisions = [...planHistory].reverse()
  const plan = selectedPlan
  const selectedIndex = plan
    ? Math.max(
        0,
        revisions.findIndex((revision) => revision.requestId === plan.requestId),
      )
    : -1
  const isPending = !!plan && plan.requestId === pendingPlan?.requestId
  const canGoBack = selectedIndex > 0
  const canGoForward = selectedIndex >= 0 && selectedIndex < revisions.length - 1
  const showRevision = (index: number) => {
    const revision = revisions[index]
    if (revision) selectPlan(revision.requestId)
  }

  return (
    <div className="flex h-full w-[400px] shrink-0 flex-col border-l border-[var(--basis-border)] bg-[var(--basis-canvas-bg)]">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--basis-border-muted)] px-4 py-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className={`min-w-0 truncate ${typographyLabel} text-[var(--basis-text)]`}>
            {plan?.name || 'Plan'}
          </span>
          {plan ? <StatusBadge status={plan.status} /> : null}
        </div>
        <button
          type="button"
          onClick={closePanel}
          aria-label="Close plan panel"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--basis-text-muted)] transition-colors hover:bg-[var(--basis-surface-hover)] hover:text-[var(--basis-text)]"
        >
          <XIcon className="h-4 w-4" />
        </button>
      </div>

      {plan && revisions.length > 0 ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--basis-border-muted)] bg-[var(--basis-surface)]/45 px-4 py-2">
          <div className="min-w-0 flex-1">
            <div
              className={`${typographyCaptionTiny} uppercase tracking-[0.12em] text-[var(--basis-text-faint)]`}
            >
              Revision {selectedIndex + 1} of {revisions.length}
            </div>
            <div className={`${typographyCaption} truncate text-[var(--basis-text-muted)]`}>
              {revisionTime(plan.createdAt)}
            </div>
          </div>
          <div className="flex items-center gap-0.5 rounded-md border border-[var(--basis-border-muted)] bg-[var(--basis-canvas-bg)] p-0.5">
            <button
              type="button"
              onClick={() => showRevision(selectedIndex - 1)}
              disabled={!canGoBack}
              aria-label="Previous plan revision"
              className="flex h-6 w-6 items-center justify-center rounded text-[var(--basis-text-muted)] transition-colors hover:bg-[var(--basis-surface-hover)] hover:text-[var(--basis-text)] disabled:opacity-25"
            >
              <CaretLeftIcon className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => showRevision(selectedIndex + 1)}
              disabled={!canGoForward}
              aria-label="Next plan revision"
              className="flex h-6 w-6 items-center justify-center rounded text-[var(--basis-text-muted)] transition-colors hover:bg-[var(--basis-surface-hover)] hover:text-[var(--basis-text)] disabled:opacity-25"
            >
              <CaretRightIcon className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 custom-scrollbar">
        {plan ? (
          <PlanBody plan={plan} />
        ) : (
          <div className={`${typographyCaption} text-[var(--basis-text-muted)]`}>
            No plan to show.
          </div>
        )}
      </div>

      {plan && isPending ? (
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-[var(--basis-border-muted)] px-4 py-3">
          <span className={`${typographyCaption} text-[var(--basis-text-muted)]`}>
            Waiting for your review.
          </span>
          <button
            type="button"
            onClick={() => void buildPendingPlan()}
            disabled={isBuilding}
            className={`${buildButtonClass} disabled:cursor-wait disabled:opacity-60`}
          >
            {isBuilding ? 'Starting…' : 'Build'}
          </button>
        </div>
      ) : plan && pendingPlan ? (
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-[var(--basis-border-muted)] px-4 py-3">
          <span className={`${typographyCaption} text-[var(--basis-text-muted)]`}>
            Viewing an earlier revision.
          </span>
          <button
            type="button"
            onClick={() => selectPlan(pendingPlan.requestId)}
            className={`rounded-[var(--basis-chat-shell-radius)] border border-[var(--basis-border)] px-2.5 py-1 ${typographyLabelSm} text-[var(--basis-text)] transition-colors hover:bg-[var(--basis-surface-hover)]`}
          >
            Current plan
          </button>
        </div>
      ) : null}
    </div>
  )
}
