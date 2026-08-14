import { CaretDownIcon, CaretLeftIcon, CaretRightIcon, PlayIcon } from '@phosphor-icons/react'
import type { PlanTodo, PlanTodoStatus } from '@agentpack/contract'
import { usePlanStateOptional, type PlanRow } from '../../providers/plan-provider'
import { TextPart } from '../parts/TextPart'
import { typographyBody, typographyCaptionTiny, typographyLabelSm } from '../../lib/typography'
import { cn } from '../../lib/utils'

const buildButtonClass = cn(
  'inline-flex h-[18px] shrink-0 items-center gap-0.5 rounded-[3px] border-0',
  'bg-[var(--basis-action-bg)] px-1 py-px',
  typographyCaptionTiny,
  'leading-none text-[var(--basis-action-fg)] transition-colors',
  'hover:bg-[var(--basis-action-hover)]',
  'disabled:cursor-wait disabled:opacity-60',
)

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
    <div className="flex flex-col gap-3">
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

/** Review chip above the composer — expands upward in place to show the plan. */
export function ComposerPlanPrompt() {
  const ctx = usePlanStateOptional()
  if (!ctx?.pendingPlan || !ctx.activeSessionId) return null

  const {
    pendingPlan,
    planHistory,
    selectedPlan,
    selectPlan,
    isExpanded,
    expandPlan,
    collapsePlan,
    buildPendingPlan,
    isBuilding,
  } = ctx

  const plan = selectedPlan ?? pendingPlan
  const title = pendingPlan.name || 'Untitled plan'
  const revisions = [...planHistory].reverse()
  const selectedIndex = plan
    ? Math.max(
        0,
        revisions.findIndex((revision) => revision.requestId === plan.requestId),
      )
    : -1
  const canGoBack = selectedIndex > 0
  const canGoForward = selectedIndex >= 0 && selectedIndex < revisions.length - 1
  const viewingEarlier = !!plan && plan.requestId !== pendingPlan.requestId

  const toggle = () => {
    if (isExpanded) collapsePlan()
    else expandPlan()
  }

  return (
    <div
      className={cn(
        'mb-1.5 overflow-hidden border border-[var(--basis-border-muted)] bg-[var(--basis-surface)]/95 backdrop-blur-sm',
        isExpanded ? 'rounded-[var(--basis-chat-shell-radius)]' : 'rounded-full',
      )}
    >
      {isExpanded ? (
        <div className="border-b border-[var(--basis-border-muted)]">
          <div className="custom-scrollbar max-h-[min(55vh,480px)] overflow-y-auto px-3 py-2.5">
            {plan ? <PlanBody plan={plan} /> : null}
          </div>
          {revisions.length > 1 || viewingEarlier ? (
            <div className="flex items-center justify-between gap-2 px-2.5 pb-2">
              {revisions.length > 1 ? (
                <div className="flex items-center gap-0.5 rounded-md border border-[var(--basis-border-muted)] p-0.5">
                  <button
                    type="button"
                    onClick={() => {
                      const revision = revisions[selectedIndex - 1]
                      if (revision) selectPlan(revision.requestId)
                    }}
                    disabled={!canGoBack}
                    aria-label="Previous plan revision"
                    className="flex h-5 w-5 items-center justify-center rounded text-[var(--basis-text-muted)] transition-colors hover:bg-[var(--basis-surface-hover)] hover:text-[var(--basis-text)] disabled:opacity-25"
                  >
                    <CaretLeftIcon className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const revision = revisions[selectedIndex + 1]
                      if (revision) selectPlan(revision.requestId)
                    }}
                    disabled={!canGoForward}
                    aria-label="Next plan revision"
                    className="flex h-5 w-5 items-center justify-center rounded text-[var(--basis-text-muted)] transition-colors hover:bg-[var(--basis-surface-hover)] hover:text-[var(--basis-text)] disabled:opacity-25"
                  >
                    <CaretRightIcon className="h-3 w-3" />
                  </button>
                </div>
              ) : (
                <span />
              )}
              {viewingEarlier ? (
                <button
                  type="button"
                  onClick={() => selectPlan(pendingPlan.requestId)}
                  className={cn(
                    'rounded-[4px] border border-[var(--basis-border)] px-1.5 py-0.5',
                    typographyLabelSm,
                    'text-[var(--basis-text)] transition-colors hover:bg-[var(--basis-surface-hover)]',
                  )}
                >
                  Current
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="group/plan-chip flex items-center gap-1.5 px-2 py-0.5">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={isExpanded}
          className={cn(
            'min-w-0 flex-1 overflow-hidden py-0.5 text-left',
            typographyLabelSm,
            'text-[var(--basis-text)]',
          )}
          title={title}
        >
          <span className="inline-flex max-w-full items-center gap-1">
            <span className="truncate">{title}</span>
            <CaretDownIcon
              className={cn(
                'h-3 w-3 shrink-0 text-[var(--basis-text-faint)] transition-[opacity,transform] duration-150',
                isExpanded ? 'opacity-100' : 'opacity-0 group-hover/plan-chip:opacity-100',
                !isExpanded && '-rotate-180',
              )}
            />
          </span>
        </button>
        <button
          type="button"
          onClick={() => void buildPendingPlan()}
          disabled={isBuilding}
          className={buildButtonClass}
        >
          <PlayIcon className="h-2.5 w-2.5" weight="fill" />
          {isBuilding ? '…' : 'Build'}
        </button>
      </div>
    </div>
  )
}
