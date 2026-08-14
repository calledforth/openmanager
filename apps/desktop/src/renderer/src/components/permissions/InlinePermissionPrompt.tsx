import { useLayoutEffect } from 'react'
import type { PermissionOption } from '@agentpack/contract'
import type { PermissionSelection } from '../../providers/app-ui-provider'
import {
  usePermissionStateOptional,
  type PendingPermission,
} from '../../providers/permission-provider'
import { typographyCaption, typographyCaptionTiny } from '../../lib/typography'

function formatValue(value: unknown): string | null {
  if (value == null) return null
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

const isAllowKind = (kind: PermissionOption['kind']) =>
  kind === 'allow_once' || kind === 'allow_always'

const OPTION_LABELS: Record<PermissionOption['kind'], string> = {
  allow_once: 'Allow',
  allow_always: 'Always allow',
  reject_once: 'Deny',
  reject_always: 'Always deny',
}

const denyButtonClass = `rounded-[3px] border-0 bg-[var(--basis-surface-hover)] px-1 py-px ${typographyCaptionTiny} leading-none text-[var(--basis-text-muted)] transition-colors hover:text-[var(--basis-text)]`
const allowButtonClass = `rounded-[3px] border-0 bg-[var(--basis-action-bg)] px-1 py-px ${typographyCaptionTiny} leading-none text-[var(--basis-action-fg)] transition-colors hover:bg-[var(--basis-action-hover)]`

function PermissionCard({
  pending,
  onResolve,
  showDetails,
}: {
  pending: PendingPermission
  onResolve: (selection: PermissionSelection) => void
  showDetails: boolean
}) {
  const inputPreview = showDetails ? formatValue(pending.input) : null
  // Reject options left, allow options right; provider order kept within each group.
  const options = [...(pending.options ?? [])].sort(
    (a, b) => Number(isAllowKind(a.kind)) - Number(isAllowKind(b.kind)),
  )
  const requestLabel = showDetails
    ? `${pending.toolName} — ${pending.description}`
    : pending.description

  return (
    <div className="my-1 bg-transparent py-0.5">
      <div className={`min-w-0 ${typographyCaption} text-[var(--basis-text)]`}>
        <span className="text-[var(--basis-text-muted)]">Request</span>
        {pending.permission ? (
          <span className={`${typographyCaptionTiny} ml-1.5 text-[var(--basis-text-muted)]`}>
            {pending.permission}
          </span>
        ) : null}
        <div className="mt-0.5 truncate text-[var(--basis-text)]">{requestLabel}</div>
      </div>
      <div className="mt-1 flex flex-wrap items-center justify-end gap-1">
        {options.length > 0 ? (
          options.map((option) => (
            <button
              key={option.optionId}
              onClick={() => onResolve({ optionId: option.optionId })}
              className={isAllowKind(option.kind) ? allowButtonClass : denyButtonClass}
            >
              {option.name || OPTION_LABELS[option.kind] || option.kind}
            </button>
          ))
        ) : (
          <>
            <button onClick={() => onResolve({ approved: false })} className={denyButtonClass}>
              Deny
            </button>
            <button onClick={() => onResolve({ approved: true })} className={allowButtonClass}>
              Approve
            </button>
          </>
        )}
      </div>
      {inputPreview ? (
        <pre
          className={`m-0 mt-1 max-h-24 overflow-auto font-mono text-ui-2xs leading-relaxed text-[var(--basis-text-muted)] whitespace-pre-wrap wrap-break-word custom-scrollbar`}
        >
          {inputPreview}
        </pre>
      ) : null}
    </div>
  )
}

/**
 * Inline permission prompt attached to the tool call it gates. Rendered under every
 * tool part; shows only when the pending permission targets this tool call.
 */
export function ToolCallPermission({ callID }: { callID?: string }) {
  const ctx = usePermissionStateOptional()
  const pending = ctx?.pendingPermission ?? null
  const matches = Boolean(ctx && pending?.toolCallId && callID && pending.toolCallId === callID)
  const requestId = pending?.requestId

  // Claim before paint so the bottom-of-chat fallback never flashes alongside this prompt.
  useLayoutEffect(() => {
    if (!matches || !ctx || !requestId) return
    return ctx.claimPermission(requestId)
  }, [matches, ctx, requestId])

  if (!matches || !ctx || !pending) return null
  return <PermissionCard pending={pending} onResolve={ctx.resolvePermission} showDetails={false} />
}

/**
 * Bottom-of-conversation fallback for pending permissions that no rendered tool call
 * claimed (missing toolCallId, or the tool part has not streamed in yet).
 */
export function PendingPermissionFallback() {
  const ctx = usePermissionStateOptional()
  if (!ctx?.pendingPermission || !ctx.activeSessionId || ctx.isPermissionClaimed) return null
  return (
    <PermissionCard pending={ctx.pendingPermission} onResolve={ctx.resolvePermission} showDetails />
  )
}
