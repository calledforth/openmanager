import { XIcon } from 'phosphor-react-native'
import { useMemo, useRef } from 'react'
import { ScrollView, TextInput, View } from 'react-native'
import Animated, { Easing, SlideInDown, SlideOutDown } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { applySlashCommand } from '@openmanager/app-core/logic'

import { AppText } from '../components/ui/AppText'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { IconButton } from '../ui/IconButton'
import { ProjectSquare } from '../ui/ProjectChip'
import { ComposerNotice } from './ComposerDock'
import { ImageGlyph, SlashGlyph } from './icons'
import { ImageStrip } from './ImageStrip'
import { slashPopupOf, type ComposerModel } from './model'
import { Pick, PrimaryButton } from './Pick'
import { Picks } from './Picks'
import { SlashPopup } from './SlashPopup'
import type { ComposerUi } from './ui-state'

/**
 * Pulling the composer up: the page slides away under it, rising from the
 * bottom edge and dropping back to it; eased, no bounce, the sheet's timing.
 * Reanimated layout animations, on the UI thread.
 */
export const EXPAND_IN = SlideInDown.duration(220).easing(Easing.out(Easing.cubic))
export const EXPAND_OUT = SlideOutDown.duration(180).easing(Easing.in(Easing.cubic))

/**
 * The full-screen composer, the writing mode (Linear's create-issue shape):
 * close and the project on top, the text, then the picks as a tray above the
 * keyboard with the image and command picks and send. Every pick opens the
 * same sheet or popover as in the dock.
 */
export function ExpandedComposer({
  model,
  ui,
  contextName,
}: {
  model: ComposerModel
  ui: ComposerUi
  /** The project the session is in, named in the bar. */
  contextName: string | null
}) {
  const theme = usePhoneTheme()
  const insets = useSafeAreaInsets()
  const input = useRef<TextInput>(null)
  const { matches: slashMatches } = useMemo(
    () => slashPopupOf(model.text, model.slashCommands, false),
    [model.slashCommands, model.text],
  )
  const slashOpen = slashMatches.length > 0
  // A command is the whole message (providers read it at the start), so the
  // pick starts one only in an empty field and never replaces what is typed.
  const commandsReason =
    model.slashCommands.length === 0
      ? 'This session lists no commands'
      : model.text.trim() && !model.text.startsWith('/')
        ? 'Clear the field to pick a command'
        : null
  return (
    <Animated.View
      entering={EXPAND_IN}
      exiting={EXPAND_OUT}
      accessibilityViewIsModal
      style={{ position: 'absolute', inset: 0, backgroundColor: theme.bg }}
    >
      {/* The page's own keyboard avoider makes the room on iOS; Android resizes the window. */}
      <View style={{ flex: 1 }}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingTop: insets.top + 6,
            paddingHorizontal: 20,
            paddingBottom: 6,
          }}
        >
          <IconButton label="Back to the session" onPress={ui.collapse}>
            <XIcon size={18} color={theme.fg} />
          </IconButton>
          {contextName ? (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
                paddingVertical: 6,
                paddingHorizontal: 12,
                borderRadius: 999,
                backgroundColor: theme.hover,
              }}
            >
              <ProjectSquare name={contextName} size={10} />
              <AppText variant="text-13-regular" numberOfLines={1} style={{ color: theme.muted }}>
                {contextName}
              </AppText>
            </View>
          ) : null}
          <View style={{ width: 36 }} />
        </View>

        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ flexGrow: 1 }}
          keyboardShouldPersistTaps="handled"
        >
          <TextInput
            ref={input}
            accessibilityLabel="Message"
            autoFocus
            multiline
            value={model.text}
            onChangeText={model.setText}
            placeholder={model.placeholder}
            placeholderTextColor={theme.faint}
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

        {slashOpen ? (
          <SlashPopup
            commands={slashMatches}
            onPick={(command) => {
              model.setText(applySlashCommand(command))
              input.current?.focus()
            }}
          />
        ) : null}
        <ImageStrip images={model.images} onRemove={model.removeImage} />
        <ComposerNotice model={model} />
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            paddingTop: 8,
            paddingHorizontal: 12,
            paddingBottom: 10 + insets.bottom,
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
              accessibilityLabel="Attach a photo"
              icon={<ImageGlyph size={14} color={theme.muted} />}
              disabledReason={model.attach.enabled ? null : model.attach.reason}
              onPress={() => ui.open({ kind: 'camera' })}
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
            onSend={() => {
              model.send()
              ui.collapse()
            }}
            onStop={model.interrupt}
          />
        </View>
      </View>
    </Animated.View>
  )
}
