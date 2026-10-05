import {
  DRAFT_SAVE_MAX_BYTES,
  DraftDeletedDetailsSchema,
  draftSaveBytes,
  type DraftContent,
  type DraftTarget,
} from '@openmanager/protocol'
import {
  applyDraftDeleted,
  applyDraftEdit,
  applyDraftSaved,
  draftBaseRevision,
  forgetDraft,
  isEmptyDraftContent,
  removeDraftEdit,
  selectDraftTarget,
  settleEditOnDeletion,
} from './draft-state'
import { isEnvironmentClientError } from './errors'
import type { EnvironmentStore } from './store'
import type {
  DraftEdit,
  DraftLaunchOutcome,
  DraftStall,
  DraftSync,
  EnvironmentCommands,
  EnvironmentState,
} from './types'

/**
 * How long typing has to pause before an edit is saved to the environment.
 * Long enough that a sentence costs one write rather than one per key, short
 * enough that another device sees the draft while the user is still there.
 * Every edit is in the state, and so in the host's cache, at once; leaving
 * the composer or hiding the page saves without waiting.
 */
export const DRAFT_SAVE_DEBOUNCE_MS = 1_000

const LIST_RETRY_MIN_MS = 1_000
const LIST_RETRY_MAX_MS = 30_000
// A save that failed on a live connection is tried again on these terms.
const SAVE_RETRY_MIN_MS = 1_000
const SAVE_RETRY_MAX_MS = 30_000

export interface DraftSyncOptions {
  store: EnvironmentStore
  commands: Pick<EnvironmentCommands, 'listDrafts' | 'saveDraft' | 'deleteDraft'>
  /** Whether the connected environment keeps drafts. */
  supported: () => boolean
  debounceMs?: number
  now?: () => number
}

const sameJson = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)

/**
 * Saves a client's draft edits to the environment, one request per draft at
 * a time so a later edit can never overtake an earlier one, and lists the
 * environment's drafts whenever the client may have missed changes to them.
 */
export function createDraftSync(options: DraftSyncOptions): DraftSync & { dispose(): void } {
  const { store, commands } = options
  const debounceMs = options.debounceMs ?? DRAFT_SAVE_DEBOUNCE_MS
  const now = options.now ?? Date.now
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const inFlight = new Set<string>()
  // Drafts whose delete this client has sent and not yet seen answered.
  const deleting = new Set<string>()
  const again = new Set<string>()
  // The wait before trying a failed save again, by draft.
  const saveRetryMs = new Map<string, number>()
  let listing = false
  let wasConnected = false
  let disposed = false

  const ready = (state: EnvironmentState) =>
    state.connection.phase === 'connected' && state.draftsListed && options.supported()

  const cancel = (draftId: string) => {
    const timer = timers.get(draftId)
    if (timer === undefined) return
    clearTimeout(timer)
    timers.delete(draftId)
  }

  const schedule = (draftId: string, delay = debounceMs) => {
    cancel(draftId)
    timers.set(
      draftId,
      setTimeout(() => {
        timers.delete(draftId)
        void write(draftId)
      }, delay),
    )
  }

  /** Say why the draft's waiting edit has not reached the environment. */
  const stall = (draftId: string, reason: DraftStall) => {
    store.update((state) => {
      const current = state.draftEdits[draftId]
      if (!current || current.launching || current.stalled === reason) return state
      return applyDraftEdit(state, draftId, { ...current, stalled: reason })
    })
  }

  /**
   * After a write: forget the edit it carried, or rebase what was typed
   * meanwhile on it. The environment announces a write before it answers it,
   * so no deletion this client is waiting for can still arrive.
   */
  const settle =
    (draftId: string, sent: DraftEdit, revision: number) => (state: EnvironmentState) => {
      const current = state.draftEdits[draftId]
      if (!current) return state
      if (current === sent) return removeDraftEdit(state, draftId, sent)
      const rebased: DraftEdit = {
        ...current,
        baseRevision: Math.max(current.baseRevision, revision),
      }
      delete rebased.outlivesDeletion
      // A stall mark stays: what was typed meanwhile is still not in the
      // environment, and the mark only goes with the write that carries it.
      return applyDraftEdit(state, draftId, rebased)
    }

  const write = async (draftId: string): Promise<void> => {
    cancel(draftId)
    if (disposed) return
    if (inFlight.has(draftId)) {
      again.add(draftId)
      return
    }
    const state = store.getState()
    const edit = state.draftEdits[draftId]
    if (!edit || edit.launching) return
    if (isEmptyDraftContent(edit.content) && edit.baseRevision === 0 && !state.drafts[draftId]) {
      // Never reached the environment, and nothing is on its way there: there
      // is nothing to delete, connected or not.
      store.update((current) => removeDraftEdit(current, draftId, edit))
      return
    }
    if (!ready(state)) {
      // Kept for the flush that follows the next connect and listing. A
      // listing under way is a moment's wait, not an unreachable environment.
      if (state.connection.phase !== 'connected') stall(draftId, 'offline')
      else if (!options.supported()) stall(draftId, 'unsupported')
      return
    }
    const input = {
      draftId,
      baseRevision: edit.baseRevision,
      target: edit.target,
      content: edit.content,
    }
    // Too big for one message to the environment: kept here, in the state
    // and the host's cache, and saved once it is short enough again.
    if (draftSaveBytes(input) > DRAFT_SAVE_MAX_BYTES) {
      stall(draftId, 'too_large')
      return
    }
    inFlight.add(draftId)
    try {
      if (isEmptyDraftContent(edit.content)) {
        deleting.add(draftId)
        const tombstone = await commands
          .deleteDraft({ draftId, baseRevision: edit.baseRevision })
          .finally(() => {
            deleting.delete(draftId)
          })
        // Rebase first: what was typed after the delete was sent is the
        // next draft, which the deletion must not take with it.
        store.update((current) =>
          applyDraftDeleted(settle(draftId, edit, tombstone.revision)(current), tombstone),
        )
      } else {
        const draft = await commands.saveDraft(input)
        store.update((current) =>
          settle(draftId, edit, draft.revision)(applyDraftSaved(current, draft)),
        )
      }
      // Got through: the next failure starts over from the shortest wait.
      saveRetryMs.delete(draftId)
    } catch (error) {
      if (isEnvironmentClientError(error)) {
        const deleted = DraftDeletedDetailsSchema.safeParse(error.details)
        if (error.code === 'conflict' && deleted.success) {
          // Sent or discarded elsewhere since this was typed: it stays gone,
          // unless this is what a failed send put back, which is saved again
          // on top of the deletion.
          const retry = store.getState().draftEdits[draftId]?.outlivesDeletion === true
          // The deletion may be older than a draft saved on top of it since,
          // so the edit is settled against it whatever the draft's state.
          store.update((current) => {
            const next = applyDraftDeleted(current, deleted.data)
            const draftEdits = settleEditOnDeletion(next.draftEdits, draftId, deleted.data.revision)
            return draftEdits === next.draftEdits ? next : { ...next, draftEdits }
          })
          if (retry) again.add(draftId)
          return
        }
        if (error.code === 'validation' || error.code === 'not_found') {
          // Saving it again cannot work: its session is gone, or it was never valid.
          store.update((current) => removeDraftEdit(current, draftId, edit))
          return
        }
      }
      // Anything else (no connection, a busy environment) stays marked until
      // a save gets through: tried again after a wait while connected, else
      // by the flush that follows the next connect. Never dropped.
      if (store.getState().connection.phase !== 'connected') {
        stall(draftId, 'offline')
      } else if (!disposed) {
        stall(draftId, 'failed')
        const delay = saveRetryMs.get(draftId) ?? SAVE_RETRY_MIN_MS
        saveRetryMs.set(draftId, Math.min(delay * 2, SAVE_RETRY_MAX_MS))
        schedule(draftId, delay)
      }
    } finally {
      inFlight.delete(draftId)
      // Nothing left to try again: saved, refused, or forgotten meanwhile.
      if (!store.getState().draftEdits[draftId]) saveRetryMs.delete(draftId)
      if (again.delete(draftId)) void write(draftId)
    }
  }

  /** Save every waiting edit now, the least recently edited draft first. */
  const flush = () => {
    const waiting = Object.entries(store.getState().draftEdits)
      .filter(([, edit]) => !edit.launching)
      .sort(([, left], [, right]) => left.editedAt - right.editedAt)
    for (const [draftId] of waiting) void write(draftId)
  }

  // A listing that failed on a live connection is tried again, backing off,
  // since no state change may come along to prompt it.
  let listRetry: ReturnType<typeof setTimeout> | undefined
  let listRetryMs = LIST_RETRY_MIN_MS
  const list = () => {
    if (listing) return
    listing = true
    if (listRetry !== undefined) clearTimeout(listRetry)
    listRetry = undefined
    commands
      .listDrafts()
      .then(
        () => {
          listRetryMs = LIST_RETRY_MIN_MS
          flush()
        },
        () => {
          if (disposed) return
          // Nothing is saved before the listing, so every waiting edit is
          // stuck with it until a retry gets through. A save already on the
          // wire is left alone: its own answer settles it.
          for (const [draftId, edit] of Object.entries(store.getState().draftEdits)) {
            if (!edit.launching && !inFlight.has(draftId)) stall(draftId, 'failed')
          }
          listRetry = setTimeout(() => {
            listRetry = undefined
            check()
          }, listRetryMs)
          listRetryMs = Math.min(listRetryMs * 2, LIST_RETRY_MAX_MS)
        },
      )
      .finally(() => {
        listing = false
      })
  }

  const check = () => {
    if (disposed) return
    const state = store.getState()
    const connected = state.connection.phase === 'connected'
    const reconnected = connected && !wasConnected
    wasConnected = connected
    if (!connected || !options.supported()) return
    if (!state.draftsListed) list()
    else if (reconnected) flush()
  }
  const unsubscribe = store.subscribe(check)
  // A store handed over already connected changes nothing to notice.
  queueMicrotask(check)

  return {
    edit(draftId: string, target: DraftTarget, content: DraftContent) {
      const state = store.getState()
      const held = state.draftEdits[draftId]
      const saved = state.drafts[draftId]
      if (held) {
        if (sameJson(held.content, content) && sameJson(held.target, target)) return
      } else if (saved) {
        if (sameJson(saved.content, content) && sameJson(saved.target, target)) return
      } else if (isEmptyDraftContent(content)) {
        return
      }
      const edit: DraftEdit = {
        target,
        content,
        baseRevision: held?.baseRevision ?? draftBaseRevision(state, draftId),
        editedAt: now(),
        ...(held?.launching ? { launching: true as const } : {}),
        // Still not in the environment: the mark stays until a save lands.
        ...(held?.stalled ? { stalled: held.stalled } : {}),
        // Typed while this client's delete of the draft is on the wire: the
        // draft's next text, which that deletion must not take with it.
        ...(held?.outlivesDeletion || deleting.has(draftId)
          ? { outlivesDeletion: true as const }
          : {}),
      }
      store.update((current) => applyDraftEdit(current, draftId, edit))
      if (!edit.launching) schedule(draftId)
    },

    discard(draftId: string) {
      const state = store.getState()
      const target = selectDraftTarget(state, draftId)
      // A draft being sent is the send's: it goes with the session, or comes
      // back whole if the send fails.
      if (!target || state.draftEdits[draftId]?.launching) return
      this.edit(draftId, target, { text: '' })
      void write(draftId)
    },

    beginLaunch(draftId: string) {
      cancel(draftId)
      store.update((state) => {
        const held = state.draftEdits[draftId]
        const saved = state.drafts[draftId]
        const edit: DraftEdit | undefined = held
          ? { ...held, launching: true }
          : saved
            ? {
                target: saved.target,
                content: saved.content,
                baseRevision: saved.revision,
                editedAt: now(),
                launching: true,
              }
            : undefined
        return edit ? applyDraftEdit(state, draftId, edit) : state
      })
    },

    endLaunch(draftId: string, outcome: DraftLaunchOutcome) {
      const state = store.getState()
      const held = state.draftEdits[draftId]
      if (!held?.launching) return
      if (outcome === 'sent') {
        // The environment deleted it with the session; its event follows. Not
        // offered meanwhile, so the next keystroke starts the next draft.
        store.update((current) => forgetDraft(current, draftId))
        return
      }
      // Refused: whether the environment got as far as deleting the draft is
      // not known yet, so the edit is kept and saved whatever it announces.
      // Aborted: nothing was asked, and a deletion that arrives now is
      // another client's send or discard, which the edit must not outlive.
      const restored: DraftEdit =
        outcome === 'refused' ? { ...held, outlivesDeletion: true } : { ...held }
      delete restored.launching
      store.update((current) => applyDraftEdit(current, draftId, restored))
      schedule(draftId)
    },

    flush,

    dispose() {
      disposed = true
      if (listRetry !== undefined) clearTimeout(listRetry)
      unsubscribe()
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
    },
  }
}
