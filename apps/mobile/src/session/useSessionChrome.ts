import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { holdWhilePending, type SessionMenuItem, type SessionMenuItemId } from './session-menu'
import type { SessionActions } from './useSessionActions'

/** The server keeps titles up to this long. */
export const TITLE_MAX = 512
/** A failure stays under the title this long, unless the reader acts again. */
export const FAILURE_MS = 6000

/** What the line under the title says while a command is out, or why it failed. */
export type HeaderNote = { kind: 'busy' | 'failed'; text: string } | null

type Command = SessionMenuItemId | 'rename'

const BUSY_WORDS: Partial<Record<Command, string>> = {
  rename: 'Renaming…',
  'regenerate-title': 'Naming the session…',
  settle: 'Settling…',
  unsettle: 'Moving back to active…',
  'stop-background': 'Stopping background work…',
}
const FAILED_WORDS: Partial<Record<Command, string>> = {
  rename: 'Could not rename',
  'regenerate-title': 'Could not name it',
  settle: 'Could not settle',
  unsettle: 'Could not move it back',
  'stop-background': 'Could not stop the background work',
}

const reasonOf = (error: unknown) =>
  error instanceof Error && error.message ? error.message : 'the environment refused'

/**
 * The header's state: the ⋯ menu, the title being edited, and the note for
 * the command in flight. One command at a time: while one is out, the
 * menu's other items and the title wait (listed, dimmed, with why), so two
 * answers never race for the one line under the title. Each command carries
 * a token, and only the current one may write the note. Commands go to the
 * environment; the title and the session's place are whatever it then lists.
 */
export function useSessionChrome(actions: SessionActions | null, title: string) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [note, setNote] = useState<HeaderNote>(null)
  const [pending, setPending] = useState(false)
  const current = useRef(0)
  const pendingRef = useRef(false)
  useEffect(() => {
    return () => {
      // Nothing that answers after the page has gone may write to it.
      current.current += 1
    }
  }, [])
  useEffect(() => {
    if (note?.kind !== 'failed') return
    const timer = setTimeout(() => setNote(null), FAILURE_MS)
    return () => clearTimeout(timer)
  }, [note])

  const send = useCallback((id: Command, command: () => Promise<void>) => {
    if (pendingRef.current) return
    const token = ++current.current
    pendingRef.current = true
    setPending(true)
    setNote({ kind: 'busy', text: BUSY_WORDS[id] ?? 'Working…' })
    const settle = (next: HeaderNote) => {
      if (token !== current.current) return
      pendingRef.current = false
      setPending(false)
      setNote(next)
    }
    command().then(
      () => settle(null),
      (error: unknown) =>
        settle({ kind: 'failed', text: `${FAILED_WORDS[id] ?? 'Failed'}: ${reasonOf(error)}` }),
    )
  }, [])

  const menu: readonly SessionMenuItem[] = useMemo(
    () => holdWhilePending(actions?.menu ?? [], pending),
    [actions, pending],
  )
  const canRename = menu.some((item) => item.id === 'rename' && !item.disabledReason)

  const choose = useCallback(
    (id: SessionMenuItemId) => {
      setMenuOpen(false)
      if (!actions || pendingRef.current) return
      if (id === 'rename') {
        setEditing(true)
        return
      }
      send(id, () => actions.run(id))
    },
    [actions, send],
  )

  const commitTitle = useCallback(
    (next: string) => {
      setEditing(false)
      const trimmed = next.trim().slice(0, TITLE_MAX)
      if (!actions || !trimmed || trimmed === title) return
      send('rename', () => actions.rename(trimmed))
    },
    [actions, send, title],
  )

  const openMenu = useCallback(() => setMenuOpen(true), [])
  const closeMenu = useCallback(() => setMenuOpen(false), [])
  const startEditing = useCallback(() => {
    if (!pendingRef.current) setEditing(true)
  }, [])

  return useMemo(
    () => ({
      menuOpen,
      openMenu,
      closeMenu,
      /** The menu's items, the others held while a command is out. */
      menu,
      editing,
      startEditing,
      commitTitle,
      canRename,
      pending,
      note,
      choose,
    }),
    [
      canRename,
      choose,
      closeMenu,
      commitTitle,
      editing,
      menu,
      menuOpen,
      note,
      openMenu,
      pending,
      startEditing,
    ],
  )
}

export type SessionChrome = ReturnType<typeof useSessionChrome>
