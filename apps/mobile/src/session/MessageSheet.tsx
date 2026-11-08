import * as Clipboard from 'expo-clipboard'
import { CheckIcon, CopyIcon, CursorTextIcon, type IconProps } from 'phosphor-react-native'
import { useEffect, useMemo, useState, type ComponentType } from 'react'
import { ScrollView, Text, useWindowDimensions, View, type TextStyle } from 'react-native'
import Animated, { Easing, FadeIn } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { parseMessage } from '../components/parts/TextPart'
import { AppText } from '../components/ui/AppText'
import type { PhoneTheme } from '../theme/tokens'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { tap } from '../ui/haptics'
import { Press } from '../ui/Press'
import { Sheet } from '../ui/Sheet'
import {
  messageRuns,
  type MarkdownNode,
  type MessageRun,
  type MessageTarget,
  type RunMarks,
} from './message-text'

const MONO = 'JetBrainsMono-Regular'
const SANS = 'Geist-Regular'
const SANS_MEDIUM = 'Geist-Medium'

/** How long "Copied" shows before the sheet goes. */
const COPIED_MS = 650
/** The select view's text fades in where the actions were: short, on the UI thread. */
const SELECT_IN = FadeIn.duration(180).easing(Easing.out(Easing.quad))

/**
 * A message's actions, from a long press on it: copy it whole, or select
 * from it. Selecting opens the whole message in the sheet as one text, where
 * the handles move freely across its paragraphs, lists and code; the
 * transcript's own text is drawn as many views a selection cannot cross.
 *
 * "Copy message" copies what web's copy button does: a reply's markdown as
 * written (code fenced, links whole), or the prompt as typed. A selection
 * copies the words as they read.
 */
export function MessageSheet({ target, onClose }: { target: MessageTarget; onClose: () => void }) {
  const [selecting, setSelecting] = useState(false)
  const { copied, copy } = useCopy(target.text, onClose)
  return (
    <Sheet onDismiss={onClose} onBack={onClose}>
      {selecting ? (
        <SelectView target={target} copied={copied} onCopy={copy} />
      ) : (
        <View accessibilityRole="menu" style={{ paddingHorizontal: 6, paddingBottom: 2 }}>
          <ActionRow
            icon={copied ? CheckIcon : CopyIcon}
            label={copied ? 'Copied' : 'Copy message'}
            onPress={copy}
          />
          <ActionRow icon={CursorTextIcon} label="Select text" onPress={() => setSelecting(true)} />
        </View>
      )}
    </Sheet>
  )
}

/** Copies the message, says so, and closes the sheet a moment later. */
function useCopy(text: string, onClose: () => void) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(onClose, COPIED_MS)
    return () => clearTimeout(timer)
  }, [copied, onClose])
  const copy = () => {
    if (copied) return
    Clipboard.setStringAsync(text).then(
      () => setCopied(true),
      () => undefined,
    )
  }
  return { copied, copy }
}

function ActionRow({
  icon: Icon,
  label,
  onPress,
}: {
  icon: ComponentType<IconProps>
  label: string
  onPress: () => void
}) {
  const theme = usePhoneTheme()
  return (
    <Press
      accessibilityRole="menuitem"
      accessibilityLabel={label}
      onPress={() => {
        tap()
        onPress()
      }}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        minHeight: 48,
        paddingHorizontal: 12,
        borderRadius: 12,
        backgroundColor: pressed ? theme.hover : 'transparent',
      })}
    >
      <Icon size={19} color={theme.fg} />
      <AppText variant="text-14-regular" style={{ color: theme.fg }}>
        {label}
      </AppText>
    </Press>
  )
}

/** The whole message as one selectable text, with a button to copy all of it. */
function SelectView({
  target,
  copied,
  onCopy,
}: {
  target: MessageTarget
  copied: boolean
  onCopy: () => void
}) {
  const theme = usePhoneTheme()
  const window = useWindowDimensions()
  const insets = useSafeAreaInsets()
  const runs = useMemo<MessageRun[]>(
    () =>
      target.kind === 'assistant'
        ? messageRuns(parseMessage(target.text) as unknown as MarkdownNode[])
        : [{ text: target.text, marks: {} }],
    [target],
  )
  // The sheet stands under the header's height: the page stays in sight above it.
  const maxHeight = Math.max(240, window.height - insets.top - insets.bottom - 200)
  return (
    <Animated.View entering={SELECT_IN} style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 6 }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <AppText accessibilityRole="header" variant="text-16-medium" style={{ color: theme.fg }}>
            Select text
          </AppText>
          <AppText variant="text-12-regular" style={{ color: theme.muted }}>
            Hold a word, then drag the handles
          </AppText>
        </View>
        <Press
          accessibilityRole="button"
          accessibilityLabel={copied ? 'Copied' : 'Copy all'}
          onPress={() => {
            tap()
            onCopy()
          }}
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            paddingVertical: 8,
            paddingHorizontal: 14,
            borderRadius: 999,
            backgroundColor: pressed ? theme.active : theme.hover,
          })}
        >
          {copied ? (
            <CheckIcon size={15} color={theme.fg} weight="bold" />
          ) : (
            <CopyIcon size={15} color={theme.fg} />
          )}
          <AppText variant="text-14-medium" style={{ color: theme.fg }}>
            {copied ? 'Copied' : 'Copy all'}
          </AppText>
        </Press>
      </View>
      <ScrollView
        style={{ maxHeight, borderRadius: 16, backgroundColor: theme.hover }}
        contentContainerStyle={{ paddingHorizontal: 14, paddingVertical: 12 }}
        showsVerticalScrollIndicator={false}
      >
        <MessageText runs={runs} />
      </ScrollView>
    </Animated.View>
  )
}

/** One native text for the whole message: its formatting as spans, so a selection crosses all of it. */
function MessageText({ runs }: { runs: readonly MessageRun[] }) {
  const theme = usePhoneTheme()
  return (
    <Text
      selectable
      selectionColor={theme.active}
      style={{
        color: theme.tokens['basis-text'],
        fontFamily: SANS,
        fontSize: 15,
        lineHeight: 23.25,
      }}
    >
      {runs.map((run, index) => (
        <Text key={index} style={runStyle(run.marks, theme)}>
          {run.text}
        </Text>
      ))}
    </Text>
  )
}

const HEADING_SIZES = [19, 17, 15.5, 15, 14, 14]

/** A run's look, after the transcript's markdown styles (`markdownStyles.ts`). */
function runStyle(marks: RunMarks, theme: PhoneTheme): TextStyle | undefined {
  const style: TextStyle = {}
  if (marks.quote) Object.assign(style, { color: theme.muted, fontStyle: 'italic' })
  if (marks.heading) {
    Object.assign(style, {
      fontFamily: SANS_MEDIUM,
      fontSize: HEADING_SIZES[marks.heading - 1],
      color: marks.heading === 6 ? theme.muted : theme.fg,
    })
  }
  if (marks.strong) Object.assign(style, { fontFamily: SANS_MEDIUM, color: theme.fg })
  if (marks.em) style.fontStyle = 'italic'
  if (marks.strike) Object.assign(style, { textDecorationLine: 'line-through', color: theme.muted })
  if (marks.link) Object.assign(style, { color: theme.fg, textDecorationLine: 'underline' })
  if (marks.code) {
    Object.assign(style, {
      fontFamily: MONO,
      fontSize: 13,
      color: theme.fg,
      backgroundColor: theme.active,
    })
  }
  if (marks.codeBlock) Object.assign(style, { fontFamily: MONO, fontSize: 12.5, color: theme.fg })
  if (marks.faint) style.color = theme.faint
  return Object.keys(style).length > 0 ? style : undefined
}
