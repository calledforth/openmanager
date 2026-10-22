import { CaretLeftIcon, DotsThreeIcon } from 'phosphor-react-native'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Text, TextInput, View, type TextStyle } from 'react-native'

import { ShimmerText } from '../components/chat/ShimmerText'
import { AppText } from '../components/ui/AppText'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { useGoBack } from '../ui/goBack'
import { IconButton } from '../ui/IconButton'
import { Press } from '../ui/Press'
import { ProjectChip } from '../ui/ProjectChip'
import type { SessionMenuItemId } from './session-menu'
import type { SessionActions } from './useSessionActions'

/** The server keeps titles up to this long. */
const TITLE_MAX = 512
/** A failure stays under the title this long, unless the reader acts again. */
const FAILURE_MS = 6000

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
 * the command in flight. Commands go to the environment; the title and the
 * session's place are whatever it then lists.
 */
export function useSessionChrome(actions: SessionActions | null, title: string) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [note, setNote] = useState<HeaderNote>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    if (note?.kind !== 'failed') return
    const timer = setTimeout(() => setNote(null), FAILURE_MS)
    return () => clearTimeout(timer)
  }, [note])

  const send = useCallback((id: Command, command: () => Promise<void>) => {
    setNote({ kind: 'busy', text: BUSY_WORDS[id] ?? 'Working…' })
    command().then(
      () => {
        if (mounted.current) setNote(null)
      },
      (error: unknown) => {
        if (mounted.current) {
          setNote({ kind: 'failed', text: `${FAILED_WORDS[id] ?? 'Failed'}: ${reasonOf(error)}` })
        }
      },
    )
  }, [])

  const canRename = !!actions?.menu.some((item) => item.id === 'rename' && !item.disabledReason)

  const choose = useCallback(
    (id: SessionMenuItemId) => {
      setMenuOpen(false)
      if (!actions) return
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
  const startEditing = useCallback(() => setEditing(true), [])

  return useMemo(
    () => ({
      menuOpen,
      openMenu,
      closeMenu,
      editing,
      startEditing,
      commitTitle,
      canRename,
      note,
      choose,
    }),
    [canRename, choose, closeMenu, commitTitle, editing, menuOpen, note, openMenu, startEditing],
  )
}

export type SessionChrome = ReturnType<typeof useSessionChrome>

/** The title's own type: the mockup's 22 px semibold. */
const TITLE_STYLE: TextStyle = {
  fontFamily: 'Geist-SemiBold',
  fontSize: 22,
  lineHeight: 26.5,
  letterSpacing: -0.33,
  marginTop: 4,
}

/** The title, editable in place: the field is the title, in the title's type. */
function TitleField({ title, onCommit }: { title: string; onCommit: (title: string) => void }) {
  const theme = usePhoneTheme()
  const [value, setValue] = useState(title)
  const done = useRef(false)
  const commit = () => {
    if (done.current) return
    done.current = true
    onCommit(value)
  }
  return (
    <TextInput
      accessibilityLabel="Session title"
      autoFocus
      selectTextOnFocus
      value={value}
      onChangeText={setValue}
      maxLength={TITLE_MAX}
      returnKeyType="done"
      submitBehavior="blurAndSubmit"
      onSubmitEditing={commit}
      onBlur={commit}
      underlineColorAndroid="transparent"
      cursorColor={theme.fg}
      selectionColor={theme.active}
      style={[TITLE_STYLE, { color: theme.fg, padding: 0, margin: 0 }]}
    />
  )
}

/**
 * Back and ⋯ in glass, then the project and the title: the top kept as clear
 * as it can be. A tap on the title renames the session when the environment
 * can; the line under it says what a command is doing, or why it failed.
 */
export const SessionHeader = memo(function SessionHeader({
  title,
  project,
  topInset,
  chrome,
}: {
  title: string
  project?: string
  topInset: number
  chrome: SessionChrome
}) {
  const goBack = useGoBack()
  const theme = usePhoneTheme()
  const { editing, canRename, note } = chrome
  const heading = (
    <Text accessibilityRole="header" numberOfLines={2} style={[TITLE_STYLE, { color: theme.fg }]}>
      {title}
    </Text>
  )
  return (
    <View style={{ paddingTop: topInset + 6 }}>
      <View className="flex-row items-center justify-between px-5" style={{ height: 48 }}>
        <IconButton label="Back" onPress={goBack}>
          <CaretLeftIcon size={18} color={theme.fg} weight="bold" />
        </IconButton>
        <IconButton label="Session actions" onPress={chrome.openMenu}>
          <DotsThreeIcon size={20} color={theme.fg} weight="bold" />
        </IconButton>
      </View>
      <View className="px-5" style={{ paddingTop: 2, paddingBottom: 10 }}>
        {project ? <ProjectChip name={project} /> : null}
        {editing ? (
          <TitleField title={title} onCommit={chrome.commitTitle} />
        ) : canRename ? (
          <Press
            accessibilityRole="button"
            accessibilityLabel={`${title}. Rename`}
            onPress={chrome.startEditing}
            style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
          >
            {heading}
          </Press>
        ) : (
          heading
        )}
        {note ? (
          <View style={{ marginTop: 4 }}>
            {note.kind === 'busy' ? (
              <ShimmerText variant="text-12-regular" numberOfLines={1}>
                {note.text}
              </ShimmerText>
            ) : (
              <AppText
                variant="text-12-regular"
                numberOfLines={2}
                style={{ color: theme.status.error }}
              >
                {note.text}
              </AppText>
            )}
          </View>
        ) : null}
      </View>
    </View>
  )
})
