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
import { selectDraftContent, selectDraftSyncStatus } from '@openmanager/environment-client'
import {
  QuickAgentNoticeView,
  type QuickAgentNoticeData,
} from '@openmanager/app-core/components/command/QuickAgentPalette'
import { selectLandingWorkspaceId } from '@openmanager/app-core/providers/environment-application'
import { DraftDiscardsContext } from '@openmanager/app-core/providers/environment-sidebar-drafts'
import { isEnvironmentReachable } from '@openmanager/app-core/providers/sidebar-rows'
import {
  EnvironmentChoiceContext,
  type EnvironmentChoiceValue,
  type EnvironmentOption,
} from '@openmanager/app-core/providers/sidebar-provider'
import { useConnection } from '../providers/connection-provider'
import { useEnvironmentClients } from '../providers/environment-client-provider'

function hostOf(endpoint: string) {
  try {
    return new URL(endpoint).host
  } catch {
    return endpoint
  }
}

/** The draft on the page a choice left, as it was when its text was copied. */
type Left = {
  draftId: string
  environmentId: string
  /** The revision the copy was made from: the only one the old draft may be deleted at. */
  revision: number
  images: number
}

/** A choice of environment on its way: done once its page is on screen. */
type Move = {
  environmentId: string
  /** The address it was made from, and the one it leads to. */
  origin: string
  arrival: string
  left: Left | null
  /** The draft the text was copied to, there. */
  copy: { draftId: string; sessionId: string } | null
}

/** A copied draft whose original is deleted once the copy is saved where it went. */
type Handover = { environmentId: string; copy: { draftId: string; sessionId: string }; left: Left }

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
 *   to, and only at the revision the copy was made from: written since, from
 *   another device, it stays.
 * - A draft with images is not deleted at all. It stays where it is, its card
 *   too, and the notice offers to discard it there.
 */
export function EnvironmentChoiceHost({ children }: { children: ReactNode }) {
  const { environments, links, selectedId, selectEnvironment } = useConnection()
  const { clients } = useEnvironmentClients()
  const discards = useContext(DraftDiscardsContext)
  const navigate = useNavigate()
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const [move, setMove] = useState<Move | null>(null)
  const [handovers, setHandovers] = useState<readonly Handover[]>([])
  const [opening, setOpening] = useState<EnvironmentChoiceValue['opening']>(null)
  const [notice, setNotice] = useState<QuickAgentNoticeData | null>(null)
  const noticeKey = useRef(0)

  // `links` changes with each connection, which is what `reachable` reads.
  const options = useMemo<readonly EnvironmentOption[] | null>(() => {
    if (environments.length < 2) return null
    return environments.map(({ environmentId, label }) => {
      const twin = environments.some(
        (other) => other.label === label && other.environmentId !== environmentId,
      )
      const endpoint = links.find((link) => link.environmentId === environmentId)?.endpoint
      return {
        environmentId,
        label,
        ...(twin && endpoint ? { detail: hostOf(endpoint) } : {}),
        reachable: isEnvironmentReachable(clients[environmentId]),
      }
    })
  }, [clients, environments, links])

  const live = { clients, move, navigate, pathname, selectedId, selectEnvironment }
  const liveRef = useRef(live)
  useLayoutEffect(() => {
    liveRef.current = live
  })

  // One function for good: the sidebar's data is built with it, and a health
  // report is no reason to render every card.
  const choose = useCallback<EnvironmentChoiceValue['choose']>(
    (environmentId, from, workspaceId) => {
      const { clients, move, navigate, pathname, selectedId, selectEnvironment } = liveRef.current
      const target = clients[environmentId]
      const sourceId = from?.environmentId ?? selectedId
      if (environmentId === sourceId || !isEnvironmentReachable(target)) return false
      // Already on its way: a second copy of its text would be a second draft.
      if (from && move?.left?.draftId === from.draftId) return false
      const state = from ? clients[from.environmentId]?.getState() : undefined
      // A draft being sent is the send's: it becomes a session where it was written.
      if (from && state?.draftEdits[from.draftId]?.launching) return false
      const content = from && state ? selectDraftContent(state, from.draftId) : undefined
      const left: Left | null =
        from && state && content
          ? {
              draftId: from.draftId,
              environmentId: from.environmentId,
              revision: state.drafts[from.draftId]?.revision ?? 0,
              images: content.artifactIds?.length ?? 0,
            }
          : null
      setOpening(workspaceId ? { environmentId, workspaceId } : null)

      if (content?.text.trim() && target!.drafts) {
        const targetState = target!.getState()
        const copy = { draftId: crypto.randomUUID(), sessionId: crypto.randomUUID() }
        target!.drafts.edit(
          copy.draftId,
          {
            type: 'new_session',
            // Its most recent project; one whose folder is gone says so on the page.
            workspaceId:
              selectLandingWorkspaceId(targetState) ?? targetState.workspaceOrder[0] ?? null,
            sessionId: copy.sessionId,
          },
          { text: content.text },
        )
        // Saved now rather than after the pause in typing: the original waits on it.
        void target!.drafts.flush()
        const arrival = `/drafts/${copy.draftId}`
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
    [],
  )

  const from = (environmentId: string) =>
    environments.find((item) => item.environmentId === environmentId)?.label ?? environmentId

  useEffect(() => {
    if (!move) return
    // Gone somewhere else meanwhile: the choice is off, and its draft left alone.
    if (pathname !== move.arrival && pathname !== move.origin) {
      setMove(null)
      setOpening(null)
      return
    }
    if (pathname !== move.arrival || selectedId !== move.environmentId) return
    setMove(null)
    const { left, copy } = move
    if (!left) return
    if (left.images > 0) {
      const source = clients[left.environmentId]
      noticeKey.current += 1
      setNotice({
        key: noticeKey.current,
        kind: 'message',
        message: copy
          ? `Its images stayed with the draft on ${from(left.environmentId)}`
          : `The draft and its images stayed on ${from(left.environmentId)}`,
        action: `Discard it on ${from(left.environmentId)}`,
        // Asked for, and with the usual undo.
        onOpen: () => {
          if (source) discards?.begin(source, left.draftId, { environmentId: left.environmentId })
        },
      })
      return
    }
    if (copy)
      setHandovers((current) => [...current, { environmentId: move.environmentId, copy, left }])
    // Text only in whitespace, or picks alone: nothing in it to lose.
    else clients[left.environmentId]?.drafts?.discard(left.draftId, { ifRevision: left.revision })
    // `from` reads `environments`, which the deps already have.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clients, discards, environments, move, pathname, selectedId])

  // Each original goes once its copy is saved, wherever the page has gone since.
  useEffect(() => {
    if (handovers.length === 0) return
    const leave: Array<() => void> = []
    for (const handover of handovers) {
      const target = clients[handover.environmentId]
      if (!target) continue
      const check = () => {
        const state = target.getState()
        const { draftId, sessionId } = handover.copy
        // Sent already: the text is in the session it started.
        const sent = state.sessions[sessionId] !== undefined
        const saved =
          state.drafts[draftId] !== undefined && selectDraftSyncStatus(state, draftId) === 'synced'
        const lost = !sent && !saved && selectDraftContent(state, draftId) === undefined
        if (!sent && !saved && !lost) return
        setHandovers((current) => current.filter((item) => item !== handover))
        // The copy was refused: the original is all there is.
        if (lost) return
        const { left } = handover
        clients[left.environmentId]?.drafts?.discard(left.draftId, { ifRevision: left.revision })
      }
      leave.push(target.subscribe(check))
      check()
    }
    return () => {
      for (const stop of leave) stop()
    }
  }, [clients, handovers])

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
