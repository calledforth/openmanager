import { CaretDownIcon, CaretLeftIcon } from 'phosphor-react-native'
import { memo, useRef, useState } from 'react'
import { Text, TextInput, View, type TextStyle } from 'react-native'

import { ShimmerText } from '../components/chat/ShimmerText'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { useGoBack } from '../ui/goBack'
import { tap } from '../ui/haptics'
import { Press } from '../ui/Press'
import { ProjectMark } from '../ui/ProjectMark'
import { ScreenBar } from '../ui/Screen'
import { TITLE_MAX, type HeaderNote } from './useSessionChrome'

/** The header's one row, over which the content leaves room. */
export const HEADER_ROW = 44
/** Above the row, under the status bar. */
export const HEADER_TOP = 2
/** Under the row, before the content. */
const HEADER_BOTTOM = 2
/** Back's tap target: the glyph sits flat on the page, no glass around it. */
const BACK = 40
/** From the screen's sides: Back's glyph lines up with the transcript's text. */
const SIDE = 4

/** The title's type: one line, flat on the page. */
const TITLE_STYLE: TextStyle = {
  fontFamily: 'Geist-SemiBold',
  fontSize: 16,
  lineHeight: 20,
  letterSpacing: -0.2,
}
/** The project's, under it. */
const LINE_STYLE: TextStyle = {
  fontFamily: 'Geist-Regular',
  fontSize: 12,
  lineHeight: 15,
  letterSpacing: 0.1,
}

/** The room the header takes at the top of the content, for the row that floats over it. */
export function HeaderSpace({ topInset }: { topInset: number }) {
  return <View style={{ height: topInset + HEADER_TOP + HEADER_ROW + HEADER_BOTTOM }} />
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

/** The line under the title: what a command is doing or why it failed, else the project. */
function SecondLine({
  note,
  project,
  projectId,
}: {
  note: HeaderNote | undefined
  project: string | undefined
  projectId: string | null
}) {
  const theme = usePhoneTheme()
  if (note?.kind === 'busy') {
    return (
      <ShimmerText variant="text-11-regular" numberOfLines={1}>
        {note.text}
      </ShimmerText>
    )
  }
  if (note) {
    return (
      <Text numberOfLines={1} style={[LINE_STYLE, { color: theme.status.error }]}>
        {note.text}
      </Text>
    )
  }
  if (!project) return null
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
      <ProjectMark workspaceId={projectId} size={10} />
      <Text numberOfLines={1} style={[LINE_STYLE, { color: theme.muted, flexShrink: 1 }]}>
        {project}
      </Text>
    </View>
  )
}

/**
 * The session page's chrome, one flat row over the page (see `ScreenBar`):
 * Back, then the title with the project under it, as plain text rather than
 * glass, so the header takes as little of the screen as it can. The title is
 * the page's one control: a tap opens its actions (the menu, with rename in
 * it), said by the caret after the title; a page with no actions (a blank
 * new session) shows the title as a label. While a rename is on, the field
 * takes the title's place; while a command is out, or just failed, its line
 * takes the project's place.
 */
export const SessionHeaderBar = memo(function SessionHeaderBar({
  topInset,
  title,
  project,
  projectId = null,
  note,
  editing = false,
  onCommitTitle,
  onOpen,
}: {
  topInset: number
  title: string
  project?: string
  /** The project's path, for its declared icon. */
  projectId?: string | null
  /** The line under the title while a command is out or just failed. */
  note?: HeaderNote
  /** Rename in place: the title is a field until it commits. */
  editing?: boolean
  onCommitTitle?: (title: string) => void
  /** Opens the page's actions; without it the title is a label. */
  onOpen?: () => void
}) {
  const goBack = useGoBack()
  const theme = usePhoneTheme()
  const face = {
    minHeight: HEADER_ROW - 4,
    justifyContent: 'center',
    paddingVertical: 2,
    paddingHorizontal: 6,
    borderRadius: 10,
  } as const
  const titleBlock = editing ? (
    <View style={[face, { flex: 1, minWidth: 0, backgroundColor: theme.hover }]}>
      <TitleField title={title} onCommit={(next) => onCommitTitle?.(next)} />
    </View>
  ) : (
    <Press
      accessibilityRole={onOpen ? 'button' : 'header'}
      accessibilityLabel={project ? `${title}, ${project}` : title}
      accessibilityHint={onOpen ? 'Opens session actions' : undefined}
      disabled={!onOpen}
      onPress={() => {
        tap()
        onOpen?.()
      }}
      style={({ pressed }) => [
        face,
        { flexShrink: 1, minWidth: 0, backgroundColor: pressed ? theme.hover : 'transparent' },
      ]}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
        <Text numberOfLines={1} style={[TITLE_STYLE, { color: theme.fg, flexShrink: 1 }]}>
          {title}
        </Text>
        {onOpen ? <CaretDownIcon size={10} color={theme.faint} weight="bold" /> : null}
      </View>
      <SecondLine note={note} project={project} projectId={projectId} />
    </Press>
  )
  return (
    <ScreenBar
      top={topInset + HEADER_TOP}
      height={HEADER_ROW}
      inset={SIDE}
      left={
        <>
          <Press
            accessibilityRole="button"
            accessibilityLabel="Back"
            hitSlop={4}
            onPress={() => {
              tap()
              goBack()
            }}
            style={({ pressed }) => ({
              width: BACK,
              height: BACK,
              borderRadius: BACK / 2,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: pressed ? theme.hover : 'transparent',
            })}
          >
            <CaretLeftIcon size={20} color={theme.fg} weight="bold" />
          </Press>
          {titleBlock}
        </>
      }
    />
  )
})
