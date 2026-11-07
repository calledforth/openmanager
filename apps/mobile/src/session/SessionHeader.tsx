import { CaretDownIcon, CaretLeftIcon } from 'phosphor-react-native'
import { memo, useRef, useState } from 'react'
import { Text, TextInput, View, type TextStyle } from 'react-native'

import { ShimmerText } from '../components/chat/ShimmerText'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { Glass } from '../ui/Glass'
import { useGoBack } from '../ui/goBack'
import { tap } from '../ui/haptics'
import { IconButton } from '../ui/IconButton'
import { Press } from '../ui/Press'
import { ProjectMark } from '../ui/ProjectMark'
import { ScreenBar } from '../ui/Screen'
import { TITLE_MAX, type HeaderNote } from './useSessionChrome'

/** The header's one row: as tall as its glass, over which the content leaves room. */
export const HEADER_ROW = 48
/** Above the row, under the status bar. */
const HEADER_TOP = 6
/** Under the row, before the content. */
const HEADER_BOTTOM = 6
/** The capsule's height at rest: a title line and the project's. */
const CAPSULE = 40
/** Between Back and the capsule. */
const GAP = 8

/** The title's type: one line, in the capsule. */
const TITLE_STYLE: TextStyle = {
  fontFamily: 'Geist-SemiBold',
  fontSize: 15,
  lineHeight: 18,
  letterSpacing: -0.2,
}
/** The project's, under it. */
const LINE_STYLE: TextStyle = {
  fontFamily: 'Geist-Regular',
  fontSize: 11.5,
  lineHeight: 14,
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
 * The session page's chrome, one row of glass beside the content, over it
 * (see `ScreenBar`): Back, then the title in a capsule with the project
 * under it. The capsule is the page's one control: a tap opens its actions
 * (the menu, with rename in it), said by the caret after the title; a page
 * with no actions (a blank new session) shows the capsule as a label. While
 * a rename is on, the field takes the capsule; while a command is out, or
 * just failed, its line takes the project's place.
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
    minHeight: CAPSULE,
    justifyContent: 'center',
    paddingVertical: 4,
    paddingLeft: 14,
    paddingRight: onOpen ? 11 : 14,
  } as const
  const capsule = editing ? (
    <Glass radius={CAPSULE / 2} style={{ flex: 1, minWidth: 0 }} contentStyle={face}>
      <TitleField title={title} onCommit={(next) => onCommitTitle?.(next)} />
    </Glass>
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
      style={{ flexShrink: 1, minWidth: 0 }}
    >
      {({ pressed }) => (
        <Glass
          radius={CAPSULE / 2}
          style={{ flexShrink: 1, minWidth: 0 }}
          contentStyle={[face, { backgroundColor: pressed ? theme.active : 'transparent' }]}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
            <Text numberOfLines={1} style={[TITLE_STYLE, { color: theme.fg, flexShrink: 1 }]}>
              {title}
            </Text>
            {onOpen ? <CaretDownIcon size={10} color={theme.faint} weight="bold" /> : null}
          </View>
          <SecondLine note={note} project={project} projectId={projectId} />
        </Glass>
      )}
    </Press>
  )
  return (
    <ScreenBar
      top={topInset + HEADER_TOP}
      height={HEADER_ROW}
      left={
        <>
          <IconButton label="Back" onPress={goBack}>
            <CaretLeftIcon size={18} color={theme.fg} weight="bold" />
          </IconButton>
          <View style={{ width: GAP }} />
          {capsule}
        </>
      }
    />
  )
})
