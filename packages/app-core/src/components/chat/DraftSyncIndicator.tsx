import { CloudSlashIcon } from '@phosphor-icons/react'
import { Tooltip } from '../ui/Tooltip'
import type { ComposerDraftStore } from './composerDraftStore'
import { DRAFT_SYNC_EXPLANATION, useDraftSyncStatus } from './draftSyncStatus'

export { DRAFT_SYNC_EXPLANATION, useDraftSyncStatus }

/**
 * Says so when a draft's latest edit has not reached the environment.
 * Nothing shows while an edit only waits out the pause in typing or is on
 * the wire: that is ordinary saving, not a draft at risk.
 */
export function DraftSyncIndicator({
  store,
  draftKey,
}: {
  store: ComposerDraftStore
  draftKey: string
}) {
  const status = useDraftSyncStatus(store, draftKey)
  const explanation = DRAFT_SYNC_EXPLANATION[status]
  if (!explanation) return null
  return (
    <Tooltip content={explanation}>
      <span
        role="status"
        // Focusable, so the reason in the tooltip is reachable by keyboard.
        tabIndex={0}
        aria-label={`Draft not synced. ${explanation}`}
        className="inline-flex h-6 shrink-0 cursor-default items-center gap-1 rounded-full px-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--basis-text-muted)] text-[11px] leading-none text-[var(--basis-text-muted)]"
      >
        <CloudSlashIcon size={12} aria-hidden />
        Not synced
      </span>
    </Tooltip>
  )
}
