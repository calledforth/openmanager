import { useLayoutEffect } from 'react'
import {
  usePermissionStateOptional,
  type PendingPermission,
} from '../../providers/permission-provider'
import { typographyCaption, typographyLabelSm } from '../../lib/typography'

function formatValue(value: unknown): string | null {
  if (value == null) return null
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function PermissionCard({
  pending,
  onResolve,
  showDetails,
}: {
  pending: PendingPermission
  onResolve: (approved: boolean) => void
  showDetails: boolean
}) {
  const inputPreview = showDetails ? formatValue(pending.input) : null

  return (
    <div className="my-1.5 overflow-hidden rounded-[var(--basis-chat-shell-radius)] border border-[var(--basis-border)] bg-[var(--basis-surface-elevated)]">
      <div className="flex items-center gap-3 px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className={`${typographyLabelSm} text-[var(--basis-text)]`}>
            Permission required
            {pending.permission ? (
              <span className={`${typographyCaption} ml-1.5 text-[var(--basis-text-muted)]`}>
                {pending.permission}
              </span>
            ) : null}
          </div>
          <div className={`mt-0.5 truncate ${typographyCaption} text-[var(--basis-text-muted)]`}>
            {showDetails ? `${pending.toolName} — ${pending.description}` : pending.description}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            onClick={() => onResolve(false)}
            className={`rounded-[var(--basis-chat-shell-radius)] border border-[var(--basis-border)] bg-[var(--basis-surface)] px-2.5 py-1 ${typographyLabelSm} text-[var(--basis-text-muted)] transition-colors hover:bg-[var(--basis-surface-hover)] hover:text-[var(--basis-text)]`}
          >
            Deny
          </button>
          <button
            onClick={() => onResolve(true)}
            className={`rounded-[var(--basis-chat-shell-radius)] bg-[var(--basis-action-bg)] px-2.5 py-1 ${typographyLabelSm} text-[var(--basis-action-fg)] transition-colors hover:bg-[var(--basis-action-hover)]`}
          >
            Approve
          </button>
        </div>
      </div>
      {inputPreview ? (
        <pre
          className={`m-0 max-h-32 overflow-auto border-t border-[var(--basis-border-muted)] bg-[var(--basis-canvas-bg)] px-3 py-2 font-mono text-ui-xs leading-relaxed text-[var(--basis-text-muted)] whitespace-pre-wrap wrap-break-word custom-scrollbar`}
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
  const matches = Boolean(
    ctx && pending?.toolCallId && callID && pending.toolCallId === callID,
  )
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
    <PermissionCard
      pending={ctx.pendingPermission}
      onResolve={ctx.resolvePermission}
      showDetails
    />
  )
}
