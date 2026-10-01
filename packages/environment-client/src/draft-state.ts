import type { Draft, DraftContent, DraftList, DraftTarget } from '@openmanager/protocol'
import type { DraftEdit, EnvironmentState } from './types'

const sameJson = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)

/** Nothing typed, attached or picked: such a draft is deleted rather than kept. */
export function isEmptyDraftContent(content: DraftContent): boolean {
  return (
    content.text.length === 0 &&
    content.providerId === undefined &&
    content.preference === undefined &&
    (content.artifactIds === undefined || content.artifactIds.length === 0)
  )
}

/** What a draft shows: the edit waiting to be saved, else the environment's copy. */
export function selectDraftContent(
  state: EnvironmentState,
  draftId: string,
): DraftContent | undefined {
  return state.draftEdits[draftId]?.content ?? state.drafts[draftId]?.content
}

/** The draft's composer, wherever the draft is known from. */
export function selectDraftTarget(
  state: EnvironmentState,
  draftId: string,
): DraftTarget | undefined {
  return state.draftEdits[draftId]?.target ?? state.drafts[draftId]?.target
}

/**
 * The newest unsent draft for a project, from the edits and the
 * environment's copies. A draft being sent is not offered: what is typed now
 * belongs to the next one.
 */
export function selectNewSessionDraftId(
  state: EnvironmentState,
  workspaceId: string,
): string | undefined {
  let newest: { draftId: string; at: number } | undefined
  const consider = (draftId: string, target: DraftTarget, at: number) => {
    if (target.type !== 'new_session' || target.workspaceId !== workspaceId) return
    if (state.draftEdits[draftId]?.launching) return
    if (!newest || at > newest.at || (at === newest.at && draftId > newest.draftId)) {
      newest = { draftId, at }
    }
  }
  for (const [draftId, edit] of Object.entries(state.draftEdits)) {
    // An emptied draft is still the current one until its deletion lands:
    // a send empties the composer before it names the draft it sends.
    consider(draftId, edit.target, edit.editedAt)
  }
  for (const draft of Object.values(state.drafts)) {
    if (state.draftEdits[draft.draftId]) continue
    consider(draft.draftId, draft.target, Date.parse(draft.updatedAt))
  }
  return newest?.draftId
}

/** The revision an edit made now would be based on. */
export function draftBaseRevision(state: EnvironmentState, draftId: string): number {
  return Math.max(state.drafts[draftId]?.revision ?? 0, state.draftTombstones[draftId] ?? 0)
}

export function applyDraftSaved(state: EnvironmentState, draft: Draft): EnvironmentState {
  const held = state.drafts[draft.draftId]
  if (held && held.revision >= draft.revision) return state
  const deletedAt = state.draftTombstones[draft.draftId]
  if (deletedAt !== undefined && deletedAt >= draft.revision) return state
  const draftTombstones = { ...state.draftTombstones }
  delete draftTombstones[draft.draftId]
  return {
    ...state,
    drafts: { ...state.drafts, [draft.draftId]: draft },
    draftTombstones: deletedAt === undefined ? state.draftTombstones : draftTombstones,
  }
}

/**
 * A draft was sent or deleted. An edit made before that is dropped, as the
 * environment would refuse to save it; one made on top of the deletion is
 * the session's next draft; one being sent from here is the launch's to
 * settle; and one this client made after asking for the deletion outlives it.
 */
export function applyDraftDeleted(
  state: EnvironmentState,
  tombstone: { draftId: string; revision: number },
): EnvironmentState {
  const { draftId, revision } = tombstone
  if ((state.draftTombstones[draftId] ?? 0) >= revision) return state
  const held = state.drafts[draftId]
  if (held && held.revision > revision) return state
  const drafts = { ...state.drafts }
  delete drafts[draftId]
  return {
    ...state,
    drafts: held ? drafts : state.drafts,
    draftTombstones: { ...state.draftTombstones, [draftId]: revision },
    draftEdits: settleEditOnDeletion(state.draftEdits, draftId, revision),
  }
}

/** What becomes of an edit when its draft turns out deleted at `revision`. */
export function settleEditOnDeletion(
  edits: Record<string, DraftEdit>,
  draftId: string,
  revision: number,
): Record<string, DraftEdit> {
  const edit = edits[draftId]
  if (!edit || edit.launching || edit.baseRevision >= revision) return edits
  const next = { ...edits }
  if (edit.outlivesDeletion) {
    const rebased: DraftEdit = { ...edit, baseRevision: revision }
    delete rebased.outlivesDeletion
    next[draftId] = rebased
  } else {
    delete next[draftId]
  }
  return next
}

/** A whole listing: the environment's drafts now, keeping unchanged ones' identity. */
export function applyDraftList(state: EnvironmentState, list: DraftList): EnvironmentState {
  const drafts: Record<string, Draft> = {}
  for (const draft of list.drafts) {
    const held = state.drafts[draft.draftId]
    drafts[draft.draftId] = held && sameJson(held, draft) ? held : draft
  }
  const draftTombstones: Record<string, number> = {}
  // Tombstones learned from events stay while an edit could need settling:
  // a new-session draft's is never listed, and an edit of it from before the
  // deletion must still be dropped. With no edit left, it is forgotten.
  for (const [draftId, revision] of Object.entries(state.draftTombstones)) {
    if (!state.draftEdits[draftId]) continue
    if (!drafts[draftId] || drafts[draftId].revision < revision) draftTombstones[draftId] = revision
  }
  for (const tombstone of list.tombstones) draftTombstones[tombstone.draftId] = tombstone.revision
  let draftEdits = state.draftEdits
  for (const draftId of Object.keys(state.draftEdits)) {
    const deletedAt = draftTombstones[draftId]
    if (deletedAt !== undefined) draftEdits = settleEditOnDeletion(draftEdits, draftId, deletedAt)
  }
  return { ...state, drafts, draftTombstones, draftEdits, draftsListed: true }
}

/** The environment may have changed drafts unseen; they are listed again. */
export function applyDraftsUnlisted(state: EnvironmentState): EnvironmentState {
  return state.draftsListed ? { ...state, draftsListed: false } : state
}

export function applyDraftEdit(
  state: EnvironmentState,
  draftId: string,
  edit: DraftEdit,
): EnvironmentState {
  return { ...state, draftEdits: { ...state.draftEdits, [draftId]: edit } }
}

/** Forget an edit, only if it is still `expected` when one is given. */
export function removeDraftEdit(
  state: EnvironmentState,
  draftId: string,
  expected?: DraftEdit,
): EnvironmentState {
  const edit = state.draftEdits[draftId]
  if (!edit || (expected && edit !== expected)) return state
  const draftEdits = { ...state.draftEdits }
  delete draftEdits[draftId]
  return { ...state, draftEdits }
}

/** Forget everything held for a draft the environment has just deleted. */
export function forgetDraft(state: EnvironmentState, draftId: string): EnvironmentState {
  if (!(draftId in state.drafts) && !(draftId in state.draftEdits)) return state
  const drafts = { ...state.drafts }
  const draftEdits = { ...state.draftEdits }
  delete drafts[draftId]
  delete draftEdits[draftId]
  return { ...state, drafts, draftEdits }
}

/** A session's draft goes with it, here as on the environment. */
export function removeSessionDrafts(state: EnvironmentState, sessionIds: Iterable<string>) {
  let next = state
  for (const sessionId of sessionIds) {
    if (
      !(sessionId in next.drafts) &&
      !(sessionId in next.draftEdits) &&
      !(sessionId in next.draftTombstones)
    ) {
      continue
    }
    const drafts = { ...next.drafts }
    const draftEdits = { ...next.draftEdits }
    const draftTombstones = { ...next.draftTombstones }
    delete drafts[sessionId]
    delete draftEdits[sessionId]
    delete draftTombstones[sessionId]
    next = { ...next, drafts, draftEdits, draftTombstones }
  }
  return next
}

/** A removed project's new-session drafts are kept, without the project. */
export function detachWorkspaceDrafts(
  state: EnvironmentState,
  workspaceId: string,
): EnvironmentState {
  const detach = (target: DraftTarget): DraftTarget =>
    target.type === 'new_session' && target.workspaceId === workspaceId
      ? { ...target, workspaceId: null }
      : target
  let drafts = state.drafts
  for (const draft of Object.values(state.drafts)) {
    const target = detach(draft.target)
    if (target === draft.target) continue
    if (drafts === state.drafts) drafts = { ...state.drafts }
    drafts[draft.draftId] = { ...draft, target }
  }
  let draftEdits = state.draftEdits
  for (const [draftId, edit] of Object.entries(state.draftEdits)) {
    const target = detach(edit.target)
    if (target === edit.target) continue
    if (draftEdits === state.draftEdits) draftEdits = { ...state.draftEdits }
    draftEdits[draftId] = { ...edit, target }
  }
  return drafts === state.drafts && draftEdits === state.draftEdits
    ? state
    : { ...state, drafts, draftEdits }
}
