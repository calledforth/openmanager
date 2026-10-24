import { CaretLeftIcon, DotsThreeIcon } from 'phosphor-react-native'
import { memo, useRef, useState } from 'react'
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

/** The header's button row: as tall as the buttons, over which `SessionHeaderBar` floats. */
export const HEADER_ROW = 48

/**
 * Back and ⋯ in glass, over the header's first row: beside the page's
 * content rather than in it, so they blur it (see `ScreenBar`).
 */
export const SessionHeaderBar = memo(function SessionHeaderBar({
  topInset,
  onMenu,
}: {
  topInset: number
  onMenu: () => void
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
        <IconButton label="Session actions" onPress={onMenu}>
          <DotsThreeIcon size={20} color={theme.fg} weight="bold" />
        </IconButton>
      }
    />
  )
})

/**
 * The project and the title under the header's buttons (`SessionHeaderBar`):
 * the top kept as clear as it can be. A tap on the title renames the session
 * when the environment can; the line under it says what a command is doing,
 * or why it failed.
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
  const theme = usePhoneTheme()
  const { editing, canRename, note } = chrome
  const heading = (
    <Text accessibilityRole="header" numberOfLines={2} style={[TITLE_STYLE, { color: theme.fg }]}>
      {title}
    </Text>
  )
  return (
    <View style={{ paddingTop: topInset + 6 }}>
      <View style={{ height: HEADER_ROW }} />
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
