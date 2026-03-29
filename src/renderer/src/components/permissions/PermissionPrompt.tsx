import { ShieldAlert, ShieldCheck, TerminalSquare } from 'lucide-react'
import { usePermissionState } from '../../providers/permission-provider'

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm">
      <div className="w-full max-w-xl overflow-hidden rounded-2xl border border-border/80 bg-background/95 shadow-2xl shadow-black/50">
        <div className="border-b border-border bg-linear-to-r from-amber-500/10 via-background to-background px-5 py-4">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 rounded-xl border border-amber-500/20 bg-amber-500/10 p-2 text-amber-300">
              <ShieldAlert className="size-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-foreground">Permission required</div>
              <div className="mt-1 text-xs text-muted-foreground">
                An agent action is waiting for approval before it can continue.
              </div>
            </div>
          </div>
        </div>

        <div className="space-y-4 px-5 py-4">
          <div className="rounded-xl border border-border bg-muted/40 p-3">
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
              <TerminalSquare className="size-3.5" />
              Requested tool
            </div>
            <div className="mt-2 text-sm font-medium text-foreground">
              {pendingPermission.toolName}
            </div>
            <div className="mt-1 text-sm leading-relaxed text-muted-foreground">
              {pendingPermission.description}
            </div>
          </div>

          {pendingPermission.permission && (
            <div className="text-xs text-muted-foreground">
              Permission type:{' '}
              <span className="text-foreground/80">{pendingPermission.permission}</span>
            </div>
          )}

          {inputPreview && (
            <div>
              <div className="mb-1.5 text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                Input
              </div>
              <pre className="max-h-40 overflow-auto rounded-xl border border-border bg-black/20 px-3 py-2 text-xs leading-relaxed text-foreground/80 whitespace-pre-wrap wrap-break-word">
                {inputPreview}
              </pre>
            </div>
          )}

          {patternsPreview && (
            <div>
              <div className="mb-1.5 text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                Allowed patterns
              </div>
              <pre className="max-h-28 overflow-auto rounded-xl border border-border bg-black/20 px-3 py-2 text-xs leading-relaxed text-foreground/80 whitespace-pre-wrap wrap-break-word">
                {patternsPreview}
              </pre>
            </div>
          )}

          {alwaysPatternsPreview && (
            <div>
              <div className="mb-1.5 text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                Always allow patterns
              </div>
              <pre className="max-h-28 overflow-auto rounded-xl border border-border bg-black/20 px-3 py-2 text-xs leading-relaxed text-foreground/80 whitespace-pre-wrap wrap-break-word">
                {alwaysPatternsPreview}
              </pre>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border bg-muted/20 px-5 py-4">
          <button
            onClick={() => resolvePermission(false)}
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            Deny
          </button>
          <button
            onClick={() => resolvePermission(true)}
            className="inline-flex items-center gap-2 rounded-lg bg-emerald-500 px-3 py-2 text-sm font-medium text-black transition-colors hover:bg-emerald-400"
          >
            <ShieldCheck className="size-4" />
            Approve
          </button>
        </div>
      </div>
    </div>
  )
}
