import { useEffect, useRef, type ReactNode, type RefObject } from 'react'
import { ScrollView, TextInput, View, type LayoutChangeEvent } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { usePhoneTheme } from '../theme/ThemeProvider'
import { ComposerNotice, SyncNotice } from './ComposerDock'
import { ImageGlyph, SlashGlyph } from './icons'
import { ImageStrip } from './ImageStrip'
import { useKeyboardHeight } from './keyboard'
import type { ComposerModel } from './model'
import { Pick, PrimaryButton } from './Pick'
import { measure, Picks } from './Picks'
import type { ComposerUi } from './ui-state'

/**
 * The composer as a page of its own, for a new session: `head` (the project)
 * on top under the page's header, the text filling what is left, and the
 * picks as a tray above the keyboard with the image and command picks and
 * send. Every pick opens the same sheet or popover as in the dock.
 *
 * Page content, drawn in the session page's glass target: the sheets and the
 * command list float over it from the composer's layer, and the tray says how
 * tall it is (`onTrayHeight`) so the command list can stand on it.
 */
export function ComposerPage({
  model,
  ui,
  input,
  head,
  ready,
  onTrayHeight,
}: {
  model: ComposerModel
  ui: ComposerUi
  input: RefObject<TextInput | null>
  head: ReactNode
  /** Nothing stands between the reader and writing: the keyboard rises, once, when this holds. */
  ready: boolean
  onTrayHeight: (height: number) => void
}) {
  const theme = usePhoneTheme()
  const insets = useSafeAreaInsets()
  const keyboard = useKeyboardHeight()
  const attachRef = useRef<View>(null)
  const raised = useRef(false)
  useEffect(() => {
    if (!ready || raised.current) return
    raised.current = true
    input.current?.focus()
  }, [input, ready])
  const onTrayLayout = (event: LayoutChangeEvent) =>
    onTrayHeight(Math.round(event.nativeEvent.layout.height))
  // A command is the whole message (providers read it at the start), so the
  // pick starts one only in an empty field and never replaces what is typed.
  const commandsReason =
    model.slashCommands.length === 0
      ? 'This session lists no commands'
      : model.text.trim() && !model.text.startsWith('/')
        ? 'Clear the field to pick a command'
        : null
  return (
    <View style={{ flex: 1 }}>
      {head}
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ flexGrow: 1 }}
        keyboardShouldPersistTaps="handled"
      >
        <TextInput
          ref={input}
          accessibilityLabel="Message"
          multiline
          value={model.text}
          onChangeText={model.setText}
          placeholder={model.placeholder}
          placeholderTextColor={theme.faint}
          underlineColorAndroid="transparent"
          cursorColor={theme.fg}
          selectionColor={theme.active}
          textAlignVertical="top"
          style={{
            flexGrow: 1,
            minHeight: 120,
            paddingHorizontal: 22,
            paddingVertical: 10,
            color: theme.fg,
            fontFamily: 'Geist-Regular',
            fontSize: 17,
            lineHeight: 25.5,
          }}
        />
      </ScrollView>

      <View onLayout={onTrayLayout}>
        <ImageStrip images={model.images} onRemove={model.removeImage} />
        <ComposerNotice model={model} />
        <SyncNotice model={model} />
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            paddingTop: 8,
            paddingHorizontal: 12,
            paddingBottom: 10 + (keyboard > 0 ? 0 : insets.bottom),
          }}
        >
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="always"
            style={{ flex: 1 }}
            contentContainerStyle={{ alignItems: 'center', gap: 6 }}
          >
            <Picks model={model} ui={ui} variant="tray" />
            <Pick
              ref={attachRef}
              accessibilityLabel="Attach a photo"
              icon={<ImageGlyph size={14} color={theme.muted} />}
              disabledReason={model.attach.enabled ? null : model.attach.reason}
              onPress={() =>
                measure(attachRef.current, (anchor) => ui.open({ kind: 'attach', anchor }))
              }
            />
            <Pick
              accessibilityLabel="Commands"
              icon={<SlashGlyph size={14} color={theme.muted} />}
              disabledReason={commandsReason}
              onPress={() => {
                if (!model.text.startsWith('/')) model.setText('/')
                input.current?.focus()
              }}
            />
          </ScrollView>
          <PrimaryButton
            action={model.primary}
            size={38}
            onSend={model.send}
            onStop={model.interrupt}
          />
        </View>
      </View>
    </View>
  )
}
