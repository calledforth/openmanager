import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import {
  selectDraftContent,
  selectDraftSyncStatus,
  type EnvironmentClient,
  type EnvironmentState,
} from '@openmanager/environment-client'
import {
  QuickAgentNoticeView,
  type QuickAgentNoticeData,
} from '@openmanager/app-core/components/command/QuickAgentPalette'
import { useDeviceStorage } from '@openmanager/app-core/logic'
import { selectLandingWorkspaceId } from '@openmanager/app-core/providers/environment-application'
import { DraftDiscardsContext } from '@openmanager/app-core/providers/environment-sidebar-drafts'
import { isEnvironmentReachable } from '@openmanager/app-core/providers/sidebar-rows'
import {
  EnvironmentChoiceContext,
  type EnvironmentChoiceValue,
  type EnvironmentOption,
} from '@openmanager/app-core/providers/sidebar-provider'
import { environmentIsDown } from '@openmanager/environment-client/connection'
import { isRecentDraftHandover, type DraftHandover, type LeftDraft } from '../lib/draft-handovers'
import { platformBeside } from '../lib/environment-names'
import { useConnection } from '../providers/connection-provider'
import { useEnvironmentClients } from '../providers/environment-client-provider'

function hostOf(endpoint: string) {
  try {
    return new URL(endpoint).host
  } catch {
    return endpoint
  }
}

/** A choice of environment on its way: done once its page is on screen. */
type Move = {
  environmentId: string
  /** The address it was made from, and the one it leads to. */
  origin: string
  arrival: string
  left: LeftDraft | null
  /** The draft the text was copied to, there. */
  copy: DraftHandover['copy'] | null
}

/**
 * Connected, caught up and its drafts listed: what it says of its drafts is
 * the environment's. A reconnect reads connected at its handshake, before the
 * catch-up that brings what changed while it was away.
 */
const listed = (state: EnvironmentState) =>
  state.connection.phase === 'connected' &&
  state.connection.caughtUp !== false &&
  state.draftsListed

/** Saved where it went, with nothing of its own on its way, or sent from there already. */
const copyArrived = (state: EnvironmentState, copy: DraftHandover['copy']) =>
  state.sessions[copy.sessionId] !== undefined ||
  (state.drafts[copy.draftId] !== undefined &&
    selectDraftSyncStatus(state, copy.draftId) === 'synced')

/**
 * Whether a draft still says exactly `text`, with no images and none on the
 * way in, and if so whether a save of its own is still on its way. Unchanged
 * with nothing waiting, it carries the revision a discard of it may name.
 */
function standingOf(
  client: EnvironmentClient,
  draftId: string,
  text: string,
): 'gone' | 'changed' | 'waiting' | { revision: number } {
  const state = client.getState()
  const content = selectDraftContent(state, draftId)
  if (!content) return 'gone'
  if (
    content.text !== text ||
    content.artifactIds?.length ||
    client.drafts?.holdsImage?.(draftId)
  ) {
    return 'changed'
  }
  // Its own last save still on its way: once it lands, the revision it gets
  // is the one to name.
  if (state.draftEdits[draftId]) return 'waiting'
  const revision = state.drafts[draftId]?.revision
  return revision === undefined ? 'gone' : { revision }
}

/**
 * The saved environments, offered to the new session page. It sits above the
 * shell keyed by environment, as a choice outlives the page it was made on.
 * Choosing is going: the selection moves, and with it the shell and every
 * command on the page, so there is no second idea of where a session will start.
 *
 * A draft has no way to be moved. Its images are stored on its environment and
 * its project and picks mean nothing on another, so its text starts a new draft
 * there. Every delete here is one the user asked for, and only once nothing is
 * lost by it:
 *
 * - The old draft is deleted once the copy is saved on the environment it went
 *   to, and only while it still says exactly what was copied: written since,
 *   on this device or another, it stays.
 * - A draft with images, or one on its way in, is not deleted at all. It stays
 *   where it is, its card too, and the notice offers to discard it there.
 * - A move, once asked for, finishes wherever the page goes. A reload or a
 *   closed tab before it settles leaves both.
 *   The copy is never deleted, so the original is the only thing that goes.
 * - It goes on its own only soon after the choice. Later, another device may
 *   have written to it offline, so the notice asks first.
 * - Where that cannot be known, both stay.
 */
export function EnvironmentChoiceHost({ children }: { children: ReactNode }) {
  const { environments, links, selectedId, selectEnvironment } = useConnection()
  const { clients } = useEnvironmentClients()
  const discards = useContext(DraftDiscardsContext)
  const storage = useDeviceStorage()
  const navigate = useNavigate()
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const [move, setMove] = useState<Move | null>(null)
  // Held by the page only: a reload or a closed tab before one settles leaves
  // both copies, which loses nothing.
  const [handovers, setHandovers] = useState<readonly DraftHandover[]>([])
  const [opening, setOpening] = useState<EnvironmentChoiceValue['opening']>(null)
  const [notice, setNotice] = useState<QuickAgentNoticeData | null>(null)
  const noticeKey = useRef(0)

  // `links` changes with each connection, which is what `reachable` reads.
  const options = useMemo<readonly EnvironmentOption[] | null>(() => {
    if (environments.length < 2) return null
    return environments.map((environment) => {
      const { environmentId, label } = environment
      const twin = environments.some(
        (other) => other.label === label && other.environmentId !== environmentId,
      )
      const link = links.find((item) => item.environmentId === environmentId)
      const endpoint = link?.endpoint
      const detail = [platformBeside(environment), twin && endpoint ? hostOf(endpoint) : undefined]
        .filter(Boolean)
        .join(' · ')
      return {
        environmentId,
        label,
        ...(detail ? { detail } : {}),
        // Down (the device offline, say) while its socket still reads connected,
        // it reads offline everywhere else, so it isn't one to pick.
        reachable:
          isEnvironmentReachable(clients[environmentId]) && !(link && environmentIsDown(link.ui)),
      }
    })
  }, [clients, environments, links])

  const labelOf = (environmentId: string) =>
    environments.find((item) => item.environmentId === environmentId)?.label ?? environmentId
  const live = {
    clients,
    links,
    handovers,
    labelOf,
    move,
    navigate,
    pathname,
    selectedId,
    selectEnvironment,
    storage,
  }
  const liveRef = useRef(live)
  useLayoutEffect(() => {
    liveRef.current = live
  })

  const track = useCallback((handover: DraftHandover) => {
    setHandovers((current) => [
      ...current.filter((item) => item.copy.draftId !== handover.copy.draftId),
      handover,
    ])
  }, [])
  const untrack = useCallback((copyDraftId: string) => {
    setHandovers((current) => current.filter((item) => item.copy.draftId !== copyDraftId))
  }, [])
  const tell = useCallback((message: string, open?: { action: string; onOpen: () => void }) => {
    noticeKey.current += 1
    setNotice({ key: noticeKey.current, kind: 'message', message, ...open })
  }, [])

  // One function for good: the sidebar's data is built with it, and a health
  // report is no reason to render every card.
  const choose = useCallback<EnvironmentChoiceValue['choose']>(
    (environmentId, from, workspaceId) => {
      const {
        clients,
        links,
        handovers,
        labelOf,
        move,
        navigate,
        pathname,
        selectedId,
        selectEnvironment,
        storage,
      } = liveRef.current
      const target = clients[environmentId]
      const sourceId = from?.environmentId ?? selectedId
      // Down as well as not reachable: a draft saved there would wait in its queue.
      const link = links.find((item) => item.environmentId === environmentId)
      if (
        environmentId === sourceId ||
        !isEnvironmentReachable(target) ||
        (link && environmentIsDown(link.ui))
      ) {
        return false
      }
      // Already on its way, or copied and waiting to go: a second copy of its
      // text would be a second draft. A draft is known by its environment and
      // its id: another environment's draft of the same id is another draft.
      // One past its window no longer goes on its own, so it can move again.
      const isFrom = (draft: { draftId: string; environmentId: string } | null | undefined) =>
        !!from && draft?.draftId === from.draftId && draft.environmentId === from.environmentId
      const copying = handovers.find(
        (handover) => isFrom(handover.left) && isRecentDraftHandover(handover),
      )
      if (copying) {
        tell(
          `This draft is moving to ${labelOf(copying.environmentId)}. The original on ${labelOf(copying.left.environmentId)} goes once the copy is saved`,
          {
            action: 'Open the copy',
            onOpen: () =>
              void liveRef.current.navigate({
                to: '/drafts/$draftId',
                params: { draftId: copying.copy.draftId },
              }),
          },
        )
        return false
      }
      if (isFrom(move?.left)) return false
      const source = from ? clients[from.environmentId] : undefined
      const state = source?.getState()
      // A draft being sent is the send's: it becomes a session where it was written.
      if (from && state?.draftEdits[from.draftId]?.launching) return false
      const content = from && state ? selectDraftContent(state, from.draftId) : undefined
      const left: LeftDraft | null =
        from && state && content
          ? {
              draftId: from.draftId,
              environmentId: from.environmentId,
              revision: state.drafts[from.draftId]?.revision ?? 0,
              text: content.text,
              images:
                (content.artifactIds?.length ?? 0) +
                (source?.drafts?.holdsImage?.(from.draftId) ? 1 : 0),
            }
          : null
      setOpening(workspaceId ? { environmentId, workspaceId } : null)

      // Somewhere that keeps drafts: anywhere else, the text stays where it is.
      if (left?.text.trim() && target!.drafts && target!.supports('saveDraft')) {
        const targetState = target!.getState()
        const copy = { draftId: crypto.randomUUID(), sessionId: crypto.randomUUID() }
        target!.drafts.edit(
          copy.draftId,
          {
            type: 'new_session',
            // Where its new-session page opens: the project last picked there,
            // else its most recent; one whose folder is gone says so on the page.
            workspaceId:
              selectLandingWorkspaceId(targetState, storage) ??
              targetState.workspaceOrder[0] ??
              null,
            sessionId: copy.sessionId,
          },
          { text: left.text },
        )
        // Saved now rather than after the pause in typing: the original waits on it.
        void target!.drafts.flush()
        const arrival = `/drafts/${copy.draftId}`
        // Held from the moment of the choice: asked for, it finishes whatever
        // the page does next.
        track({ environmentId, copy, arrival, left, createdAt: Date.now() })
        setMove({ environmentId, origin: pathname, arrival, left, copy })
        // In its place: the draft it replaces is on its way out. The address is
        // what moves the selection, as it is for any draft of another environment.
        void navigate({ to: '/drafts/$draftId', params: { draftId: copy.draftId }, replace: true })
        return true
      }
      setMove({ environmentId, origin: pathname, arrival: '/', left, copy: null })
      if (pathname === '/') selectEnvironment(environmentId)
      // Off the address first: another environment would look for it and find nothing.
      else void navigate({ to: '/' }).then(() => selectEnvironment(environmentId))
      return true
    },
    [tell, track],
  )

  useEffect(() => {
    if (!move) return
    // Gone somewhere else meanwhile: the page is off. Its handover is not: a
    // copy made finishes the move wherever the page has gone.
    if (pathname !== move.arrival && pathname !== move.origin) {
      setMove(null)
      setOpening(null)
      return
    }
    if (pathname !== move.arrival || selectedId !== move.environmentId) return
    setMove(null)
    const { copy, left } = move
    if (!left) return
    const { labelOf } = liveRef.current
    if (left.images > 0) {
      const source = clients[left.environmentId]
      tell(
        copy
          ? `Its images stayed with the draft on ${labelOf(left.environmentId)}`
          : `The draft and its images stayed on ${labelOf(left.environmentId)}`,
        {
          action: `Discard it on ${labelOf(left.environmentId)}`,
          // Asked for, and with the usual undo.
          onOpen: () => {
            if (source) discards?.begin(source, left.draftId, { environmentId: left.environmentId })
          },
        },
      )
      return
    }
    if (copy) return
    if (left.text.trim()) {
      // An environment that keeps no drafts: the text had nowhere to go, and stays.
      tell(
        `${labelOf(move.environmentId)} doesn't keep drafts, so this one stayed on ${labelOf(left.environmentId)}`,
        {
          action: 'Open it',
          onOpen: () =>
            void liveRef.current.navigate({
              to: '/drafts/$draftId',
              params: { draftId: left.draftId },
            }),
        },
      )
      return
    }
    // Text only in whitespace, or picks alone: nothing in it to lose. It goes
    // on a handover's terms: still what it was, with no save of its own on its
    // way, as its environment says once caught up. Otherwise it stays.
    const source = clients[left.environmentId]
    const standing =
      source && listed(source.getState()) ? standingOf(source, left.draftId, left.text) : 'gone'
    if (typeof standing === 'object') {
      source?.drafts?.discard(left.draftId, { ifRevision: standing.revision })
    }
  }, [clients, discards, move, pathname, selectedId, tell])

  // Each original goes once its copy is saved where it went, wherever the page
  // has gone since, and only while it is still what was copied: written to
  // since, here or anywhere, or given an image, it is the user's again and
  // stays. Nothing is judged from what an environment's cache says until the
  // environment has caught up and listed its drafts since connecting. Past
  // the window, the user is asked instead.
  useEffect(() => {
    if (handovers.length === 0) return
    const leave: Array<() => void> = []
    for (const handover of handovers) {
      const target = clients[handover.environmentId]
      const source = clients[handover.left.environmentId]
      if (!target || !source) continue
      const { copy, left } = handover
      let settled = false
      const settle = () => {
        settled = true
        untrack(copy.draftId)
      }
      const there = () => liveRef.current.labelOf(handover.environmentId)
      const here = () => liveRef.current.labelOf(left.environmentId)
      const check = () => {
        if (settled) return
        const state = target.getState()
        // Never saved there, and too long to be as it is: both stay.
        if (
          state.drafts[copy.draftId] === undefined &&
          state.draftEdits[copy.draftId]?.stalled === 'too_large' &&
          listed(state)
        ) {
          settle()
          tell(`This draft is too long to save on ${there()}. The original on ${here()} was kept`)
          return
        }
        if (!listed(state)) return
        if (!copyArrived(state, copy)) {
          if (selectDraftContent(state, copy.draftId) !== undefined) return
          // Refused there, deleted before it was saved, or never got there:
          // the original is all there is, and it stays.
          settle()
          // Deleted there by someone, or the original gone too, sent or
          // discarded elsewhere: theirs to say.
          if (state.draftTombstones[copy.draftId] !== undefined) return
          if (selectDraftContent(source.getState(), left.draftId) === undefined) return
          const message = `The copy on ${there()} wasn't saved. The draft is still on ${here()}`
          const { navigate, pathname } = liveRef.current
          const toOriginal = { to: '/drafts/$draftId', params: { draftId: left.draftId } } as const
          if (pathname === handover.arrival) {
            // Its page went with it: back to the draft it was copied from.
            void navigate({ ...toOriginal, replace: true })
            tell(message)
          } else {
            tell(message, {
              action: 'Open',
              onOpen: () => void liveRef.current.navigate(toOriginal),
            })
          }
          return
        }
        // Its images stayed with it, and so does it.
        if (left.images > 0) return settle()
        if (!listed(source.getState())) return
        const standing = standingOf(source, left.draftId, left.text)
        if (standing === 'waiting') return
        settle()
        if (typeof standing !== 'object') return
        if (isRecentDraftHandover(handover)) {
          source.drafts?.discard(left.draftId, { ifRevision: standing.revision })
          return
        }
        // Long after the choice: another device may have written to it
        // offline since, so the user says, and it is checked again then.
        tell(`The copy on ${there()} is saved. Discard the original on ${here()}?`, {
          action: 'Discard',
          // Both again, as they are now: the copy still saved there, and the
          // original still what was copied.
          onOpen: () => {
            const copied = target.getState()
            if (!listed(copied)) {
              tell(`${there()} isn't connected, so the original was kept`)
              return
            }
            if (!copyArrived(copied, copy)) {
              tell(`The copy on ${there()} is gone, so the original on ${here()} was kept`)
              return
            }
            if (!listed(source.getState())) {
              tell(`${here()} isn't connected, so the original was kept`)
              return
            }
            const now = standingOf(source, left.draftId, left.text)
            if (typeof now === 'object') {
              source.drafts?.discard(left.draftId, { ifRevision: now.revision })
            } else if (now !== 'gone') {
              tell(
                now === 'changed'
                  ? `The original on ${here()} has changed, so it was kept`
                  : `The original on ${here()} has a save on its way, so it was kept`,
              )
            }
          },
        })
      }
      leave.push(target.subscribe(check), source.subscribe(check))
      check()
    }
    return () => {
      for (const stop of leave) stop()
    }
  }, [clients, handovers, tell, untrack])

  const opened = useCallback(() => setOpening(null), [])
  const dismissNotice = useCallback(
    (key: number) => setNotice((current) => (current?.key === key ? null : current)),
    [],
  )
  const value = useMemo<EnvironmentChoiceValue | null>(
    () => (options ? { environments: options, selectedId, choose, opening, opened } : null),
    [choose, opened, opening, options, selectedId],
  )
  return (
    <EnvironmentChoiceContext.Provider value={value}>
      {children}
      <QuickAgentNoticeView notice={notice} onDismiss={dismissNotice} />
    </EnvironmentChoiceContext.Provider>
  )
}
