import { usePlanStateOptional } from '../../providers/plan-provider'
import { typographyCaption, typographyCaptionTiny, typographyLabelSm } from '../../lib/typography'

const buildButtonClass = `rounded-[var(--basis-chat-shell-radius)] bg-[var(--basis-action-bg)] px-2.5 py-1 ${typographyLabelSm} text-[var(--basis-action-fg)] transition-colors hover:bg-[var(--basis-action-hover)]`

/** Slim review state above the composer: the provider is paused until the user
 * builds the plan, requests changes, or explicitly cancels planning. */
export function ComposerPlanPrompt() {
  const ctx = usePlanStateOptional()
  if (!ctx?.pendingPlan || !ctx.activeSessionId) return null
  const { pendingPlan, openPanel, buildPendingPlan, isBuilding } = ctx

  return (
    <div className="mb-1.5 overflow-hidden rounded-[var(--basis-chat-shell-radius)] border border-[var(--basis-border)] bg-[var(--basis-surface-elevated)] px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={openPanel}
          className="group flex min-w-0 flex-1 flex-col items-start text-left"
        >
          <span
            className={`${typographyCaptionTiny} flex items-center gap-1.5 uppercase tracking-[0.12em] text-amber-500`}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-amber-500 shadow-[0_0_0_3px_color-mix(in_srgb,#f59e0b_14%,transparent)]" />
            Waiting for your review
          </span>
          <span
            className={`mt-0.5 min-w-0 truncate ${typographyLabelSm} text-[var(--basis-text)] transition-colors group-hover:text-[var(--basis-text-strong)]`}
          >
            {pendingPlan.name || 'Untitled plan'}
          </span>
        </button>
        <button
          type="button"
          onClick={() => void buildPendingPlan()}
          disabled={isBuilding}
          className={`${buildButtonClass} disabled:cursor-wait disabled:opacity-60`}
        >
          {isBuilding ? 'Starting…' : 'Build'}
        </button>
      </div>
      <div className={`mt-1.5 ${typographyCaption} text-[var(--basis-text-muted)]`}>
        Build when ready, or describe what should change below.
      </div>
    </div>
  )
}
