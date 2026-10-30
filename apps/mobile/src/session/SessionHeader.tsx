import { CaretLeftIcon, DotsThreeIcon } from 'phosphor-react-native'
import { memo, useRef, useState, type ReactNode } from 'react'
import { Text, TextInput, View, type TextStyle } from 'react-native'

import { ShimmerText } from '../components/chat/ShimmerText'
import { AppText } from '../components/ui/AppText'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { useGoBack } from '../ui/goBack'
import { IconButton } from '../ui/IconButton'
import { Press } from '../ui/Press'
import { ProjectChip } from '../ui/ProjectChip'
import { ScreenBar } from '../ui/Screen'
import { TITLE_MAX, type SessionChrome } from './useSessionChrome'

/** The title's type: one line, between the header's two buttons. */
const TITLE_STYLE: TextStyle = {
  fontFamily: 'Geist-SemiBold',
  fontSize: 16,
  lineHeight: 20,
  letterSpacing: -0.2,
  textAlign: 'center',
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
      style={[TITLE_STYLE, { color: theme.fg, padding: 0, margin: 0, alignSelf: 'stretch' }]}
    />
  )
}

/** The header's one row: as tall as its buttons, over which `SessionHeaderBar` floats. */
export const HEADER_ROW = 48
/** The room each button takes from the side: the bar's inset, the button, a gap. */
const BUTTON_ROOM = 20 + 36 + 10

/**
 * Back and ⋯ in glass, at the ends of the header's row: beside the page's
 * content rather than in it, so they blur it (see `ScreenBar`). A page with
 * no actions (a new session's) has no ⋯; a draft's has its own button there.
 */
export const SessionHeaderBar = memo(function SessionHeaderBar({
  topInset,
  onMenu,
  action,
}: {
  topInset: number
  onMenu?: () => void
  /** In the ⋯'s place on a page without one. */
  action?: ReactNode
}) {
  const goBack = useGoBack()
  const theme = usePhoneTheme()
  return (
    <ScreenBar
      top={topInset + 6}
      height={HEADER_ROW}
      left={
        <IconButton label="Back" onPress={goBack}>
          <CaretLeftIcon size={18} color={theme.fg} weight="bold" />
        </IconButton>
      }
      right={
        onMenu ? (
          <IconButton label="Session actions" onPress={onMenu}>
            <DotsThreeIcon size={20} color={theme.fg} weight="bold" />
          </IconButton>
        ) : (
          action
        )
      }
    />
  )
})

/**
 * The title and, under it, the project, in the header's one row between
 * Back and ⋯ (`SessionHeaderBar`): the top takes a single row, and the
 * transcript starts right under it. A tap on the title renames the session
 * when the environment can; while a command is out, or just failed, its
 * line takes the project's place.
 */
export const SessionHeader = memo(function SessionHeader({
  title,
  project,
  projectId = null,
  topInset,
  chrome,
}: {
  title: string
  project?: string
  /** The project's path, for its declared icon. */
  projectId?: string | null
  topInset: number
  chrome: SessionChrome
}) {
  const theme = usePhoneTheme()
  const { editing, canRename, note } = chrome
  const heading = (
    <Text accessibilityRole="header" numberOfLines={1} style={[TITLE_STYLE, { color: theme.fg }]}>
      {title}
    </Text>
  )
  return (
    <View style={{ paddingTop: topInset + 6, paddingBottom: 6 }}>
      <View
        style={{
          minHeight: HEADER_ROW,
          paddingHorizontal: BUTTON_ROOM,
          alignItems: 'center',
          justifyContent: 'center',
          gap: 2,
        }}
      >
        {editing ? (
          <TitleField title={title} onCommit={chrome.commitTitle} />
        ) : canRename ? (
          <Press
            accessibilityRole="button"
            accessibilityLabel={`${title}. Rename`}
            onPress={chrome.startEditing}
            style={({ pressed }) => ({ alignSelf: 'stretch', opacity: pressed ? 0.6 : 1 })}
          >
            {heading}
          </Press>
        ) : (
          heading
        )}
        {note ? (
          note.kind === 'busy' ? (
            <ShimmerText variant="text-12-regular" numberOfLines={1}>
              {note.text}
            </ShimmerText>
          ) : (
            <AppText
              variant="text-12-regular"
              numberOfLines={1}
              style={{ color: theme.status.error, textAlign: 'center' }}
            >
              {note.text}
            </AppText>
          )
        ) : project ? (
          <ProjectChip name={project} workspaceId={projectId} size={11} />
        ) : null}
      </View>
    </View>
  )
})
