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
  /** What was copied. The old draft goes only while it still says exactly this. */
  text: string
  /** Attached, or on their way in: either way they cannot go along. */
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
 *   to, and only while it still says exactly what was copied: written since,
 *   on this device or another, it stays.
 * - A draft with images, or one on its way in, is not deleted at all. It stays where it is, its card
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

  const live = { clients, handovers, move, navigate, pathname, selectedId, selectEnvironment }
  const liveRef = useRef(live)
  useLayoutEffect(() => {
    liveRef.current = live
  })

  // One function for good: the sidebar's data is built with it, and a health
  // report is no reason to render every card.
  const choose = useCallback<EnvironmentChoiceValue['choose']>(
    (environmentId, from, workspaceId) => {
      const { clients, handovers, move, navigate, pathname, selectedId, selectEnvironment } =
        liveRef.current
      const target = clients[environmentId]
      const sourceId = from?.environmentId ?? selectedId
      if (environmentId === sourceId || !isEnvironmentReachable(target)) return false
      // Already on its way, or copied and waiting to go: a second copy of its
      // text would be a second draft.
      if (
        from &&
        (move?.left?.draftId === from.draftId ||
          handovers.some(({ left }) => left.draftId === from.draftId))
      ) {
        return false
      }
      const source = from ? clients[from.environmentId] : undefined
      const state = source?.getState()
      // A draft being sent is the send's: it becomes a session where it was written.
      if (from && state?.draftEdits[from.draftId]?.launching) return false
      const content = from && state ? selectDraftContent(state, from.draftId) : undefined
      const left: Left | null =
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

      if (content?.text.trim() && target!.drafts) {
        const targetState = target!.getState()
        const copy = { draftId: crypto.randomUUID(), sessionId: crypto.randomUUID() }
        target!.drafts.edit(
          copy.draftId,
          {
            type: 'new_session',
            // Where its new-session page opens: the project last picked there,
            // else its most recent; one whose folder is gone says so on the page.
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
    if (copy) {
      setHandovers((current) => [...current, { environmentId: move.environmentId, copy, left }])
      return
    }
    // Text only in whitespace, or picks alone: nothing in it to lose. Text that
    // had nowhere to go, an environment that keeps no drafts, stays.
    if (!left.text.trim()) {
      clients[left.environmentId]?.drafts?.discard(left.draftId, { ifRevision: left.revision })
    }
    // `from` reads `environments`, which the deps already have.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clients, discards, environments, move, pathname, selectedId])

  // Each original goes once its copy is saved, wherever the page has gone
  // since, and only while it is still what was copied. Written to since, here
  // or anywhere, or given an image, it is the user's again and stays.
  useEffect(() => {
    if (handovers.length === 0) return
    const leave: Array<() => void> = []
    for (const handover of handovers) {
      const target = clients[handover.environmentId]
      const source = clients[handover.left.environmentId]
      if (!target || !source) continue
      const { left } = handover
      const done = () => setHandovers((current) => current.filter((item) => item !== handover))
      const check = () => {
        const state = target.getState()
        const { draftId, sessionId } = handover.copy
        // Sent already: the text is in the session it started.
        const sent = state.sessions[sessionId] !== undefined
        const saved =
          state.drafts[draftId] !== undefined && selectDraftSyncStatus(state, draftId) === 'synced'
        const lost = !sent && !saved && selectDraftContent(state, draftId) === undefined
        // The copy was refused: the original is all there is.
        if (lost) return done()
        if (!sent && !saved) return
        const original = source.getState()
        const content = selectDraftContent(original, left.draftId)
        // Gone already, sent or discarded elsewhere: nothing left to do.
        if (!content) return done()
        const unchanged =
          content.text === left.text &&
          !content.artifactIds?.length &&
          !source.drafts?.holdsImage?.(left.draftId)
        if (!unchanged) return done()
        // Its own last save still on its way: once it lands, the revision it
        // gets is the one to name.
        if (original.draftEdits[left.draftId]) return
        done()
        source.drafts?.discard(left.draftId, {
          ifRevision: original.drafts[left.draftId]?.revision ?? left.revision,
        })
      }
      leave.push(target.subscribe(check), source.subscribe(check))
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
