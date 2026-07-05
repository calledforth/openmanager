import { usePermissionState } from '../../providers/permission-provider'
import { typographyBodySm, typographyCaption, typographyLabel } from '../../lib/typography'

function formatValue(value: unknown): string | null {
  if (value == null) return null
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export function PermissionPrompt() {
  const { activeSessionId, pendingPermission, resolvePermission } = usePermissionState()

  if (!pendingPermission || !activeSessionId) return null

  const inputPreview = formatValue(pendingPermission.input)
  const patternsPreview = formatValue(pendingPermission.patterns)
  const alwaysPatternsPreview = formatValue(pendingPermission.alwaysPatterns)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
      <div className="w-full max-w-xl overflow-hidden rounded-[var(--basis-chat-shell-radius)] border border-[var(--basis-border)] bg-[var(--basis-surface)] shadow-lg">
        <div className="border-b border-[var(--basis-border-muted)] px-4 py-3">
          <div className={typographyLabel}>Permission required</div>
          <div className={`mt-1 ${typographyBodySm} text-[var(--basis-text-muted)]`}>
            An agent action is waiting for approval before it can continue.
          </div>
        </div>

        <div className="space-y-3 px-4 py-3">
          <div className="rounded-[var(--basis-chat-shell-radius)] border border-[var(--basis-border-muted)] bg-[var(--basis-surface-elevated)] p-3">
            <div className={`${typographyCaption} uppercase tracking-wide text-[var(--basis-text-muted)]`}>
              Requested tool
            </div>
            <div className={`mt-1.5 ${typographyBodySm} text-[var(--basis-text)]`}>
              {pendingPermission.toolName}
            </div>
            <div className={`mt-1 ${typographyBodySm} text-[var(--basis-text-muted)]`}>
              {pendingPermission.description}
            </div>
          </div>

          {pendingPermission.permission && (
            <div className={`${typographyCaption} text-[var(--basis-text-muted)]`}>
              Permission type:{' '}
              <span className="text-[var(--basis-text)]">{pendingPermission.permission}</span>
            </div>
          )}

          {inputPreview && (
            <div>
              <div className={`${typographyCaption} mb-1 uppercase tracking-wide text-[var(--basis-text-muted)]`}>
                Input
              </div>
              <pre
                className={`max-h-40 overflow-auto rounded-[var(--basis-chat-shell-radius)] border border-[var(--basis-border-muted)] bg-[var(--basis-canvas-bg)] px-3 py-2 font-mono text-ui-xs leading-relaxed text-[var(--basis-text-muted)] whitespace-pre-wrap wrap-break-word`}
              >
                {inputPreview}
              </pre>
            </div>
          )}

          {patternsPreview && (
            <div>
              <div className={`${typographyCaption} mb-1 uppercase tracking-wide text-[var(--basis-text-muted)]`}>
                Allowed patterns
              </div>
              <pre
                className={`max-h-28 overflow-auto rounded-[var(--basis-chat-shell-radius)] border border-[var(--basis-border-muted)] bg-[var(--basis-canvas-bg)] px-3 py-2 font-mono text-ui-xs leading-relaxed text-[var(--basis-text-muted)] whitespace-pre-wrap wrap-break-word`}
              >
                {patternsPreview}
              </pre>
            </div>
          )}

          {alwaysPatternsPreview && (
            <div>
              <div className={`${typographyCaption} mb-1 uppercase tracking-wide text-[var(--basis-text-muted)]`}>
                Always allow patterns
              </div>
              <pre
                className={`max-h-28 overflow-auto rounded-[var(--basis-chat-shell-radius)] border border-[var(--basis-border-muted)] bg-[var(--basis-canvas-bg)] px-3 py-2 font-mono text-ui-xs leading-relaxed text-[var(--basis-text-muted)] whitespace-pre-wrap wrap-break-word`}
              >
                {alwaysPatternsPreview}
              </pre>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-[var(--basis-border-muted)] px-4 py-3">
          <button
            onClick={() => resolvePermission(false)}
            className={`rounded-[var(--basis-chat-shell-radius)] border border-[var(--basis-border)] bg-[var(--basis-surface-elevated)] px-3 py-1.5 ${typographyBodySm} text-[var(--basis-text-muted)] transition-colors hover:bg-[var(--basis-surface-hover)] hover:text-[var(--basis-text)]`}
          >
            Deny
          </button>
          <button
            onClick={() => resolvePermission(true)}
            className={`rounded-[var(--basis-chat-shell-radius)] bg-[var(--basis-action-bg)] px-3 py-1.5 ${typographyLabel} text-[var(--basis-action-fg)] transition-colors hover:bg-[var(--basis-action-hover)]`}
          >
            Approve
          </button>
        </div>
      </div>
    </div>
  )
}
