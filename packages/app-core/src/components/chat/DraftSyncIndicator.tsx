import { useCallback, useSyncExternalStore } from 'react'
import { CloudSlashIcon } from '@phosphor-icons/react'
import type { DraftSyncStatus } from '@openmanager/environment-client'
import { Tooltip } from '../ui/Tooltip'
import type { ComposerDraftStore } from './composerDraftStore'

const EXPLANATION: Partial<Record<DraftSyncStatus, string>> = {
  offline: 'Saved on this device only. It syncs once the environment is reachable again.',
  unsupported: 'Saved on this device only. This environment does not keep drafts.',
  too_large: 'Too long to sync. Saved on this device until it is shorter.',
  failed: 'Saved on this device. Syncing failed and is being retried.',
}

/** The draft's sync status from its store; `synced` when the store does not sync. */
export function useDraftSyncStatus(store: ComposerDraftStore, draftKey: string): DraftSyncStatus {
  const read = useCallback(() => store.getSyncStatus?.(draftKey) ?? 'synced', [store, draftKey])
  return useSyncExternalStore(store.subscribe, read, read)
}

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
  const explanation = EXPLANATION[status]
  if (!explanation) return null
  return (
    <Tooltip content={explanation}>
      <span
        role="status"
        aria-label={`Draft not synced. ${explanation}`}
        className="inline-flex h-6 shrink-0 cursor-default items-center gap-1 rounded-full px-1.5 text-[11px] leading-none text-[var(--basis-text-muted)]"
      >
        <CloudSlashIcon size={12} aria-hidden />
        Not synced
      </span>
    </Tooltip>
  )
}
