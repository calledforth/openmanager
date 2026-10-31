import { CloudSlashIcon } from 'phosphor-react-native'
import { Keyboard, TextInput, View, type LayoutChangeEvent } from 'react-native'
import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import Animated, {
  cancelAnimation,
  Easing,
  FadeIn,
  FadeOut,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated'

import { AppText } from '../components/ui/AppText'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { useDockHold } from '../session/SessionDock'
import { Glass } from '../ui/Glass'
import { tap } from '../ui/haptics'
import { Press } from '../ui/Press'
import { ProviderMark } from '../ui/ProviderMark'
import {
  boxHeightOf,
  createFoldDriver,
  DOCK_PADDING,
  foldKey,
  type FoldPorts,
} from './fold-transition'
import { AttachGlyph } from './icons'
import { ImageStrip } from './ImageStrip'
import { composerFold, type ComposerModel } from './model'
import { PrimaryButton } from './Pick'
import { measure, Picks } from './Picks'
import { PermissionPrompt, PlanPrompt, QuestionPrompt } from './Prompts'
import type { ComposerUi } from './ui-state'

/**
 * The fold, B ⇄ C: the composer's box eases to its new height
 * (`useFoldHeight`, below) while the picks row and the summary chip fade in
 * and out as they mount and unmount, which they do only on a fold. All on
 * the UI thread, only through a change of the session's state (a turn
 * starting or ending, a request arriving), never per token and never for
 * text wrapping, an image or a notice.
 */
export const FOLD_IN = FadeIn.duration(200).easing(Easing.out(Easing.quad))
export const FOLD_OUT = FadeOut.duration(150).easing(Easing.in(Easing.quad))

/** Under the field: what went wrong, or why the button cannot be used. */
export function ComposerNotice({ model }: { model: ComposerModel }) {
  const theme = usePhoneTheme()
  // Why the button is held, once there is something it would do: a message
  // to send, or a turn to stop.
  const wants =
    model.primary.kind === 'stop' || model.text.trim().length > 0 || model.images.length > 0
  const text = model.notice ?? (model.primary.enabled || !wants ? null : model.primary.reason)
  if (!text) return null
  return (
    <AppText
      variant="text-12-regular"
      accessibilityLiveRegion="polite"
      style={{ color: model.notice ? theme.status.error : theme.muted, paddingHorizontal: 10 }}
    >
      {text}
    </AppText>
  )
}

/**
 * Web's "Not synced" chip, with its reason beside it: a phone has no tooltip
 * to hold the reason, and a draft at risk is worth the line. Shown only once
 * an edit has not reached the environment, never while one is saving.
 */
export function SyncNotice({ model }: { model: ComposerModel }) {
  const theme = usePhoneTheme()
  if (!model.unsynced) return null
  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={`Draft not synced. ${model.unsynced}`}
      accessibilityLiveRegion="polite"
      style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 10 }}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 4,
          paddingVertical: 2,
          paddingHorizontal: 7,
          borderRadius: 999,
          backgroundColor: theme.hover,
        }}
      >
        <CloudSlashIcon size={12} color={theme.muted} />
        <AppText variant="text-11-medium" style={{ color: theme.muted }}>
          Not synced
        </AppText>
      </View>
      <AppText
        variant="text-12-regular"
        numberOfLines={2}
        style={{ color: theme.faint, flex: 1, minWidth: 0 }}
      >
        {model.unsynced}
      </AppText>
    </View>
  )
}

/** The round attach button in the field: the camera or the photo library, or why images cannot go. */
export function AttachButton({ model, ui }: { model: ComposerModel; ui: ComposerUi }) {
  const theme = usePhoneTheme()
  const { enabled, reason } = model.attach
  const button = useRef<View>(null)
  return (
    <Press
      ref={button}
      accessibilityRole="button"
      accessibilityLabel="Attach a photo"
      accessibilityHint={reason ?? undefined}
      accessibilityState={{ disabled: !enabled }}
      disabled={!enabled}
      hitSlop={4}
      onPress={() => {
        tap()
        measure(button.current, (anchor) => ui.open({ kind: 'attach', anchor }))
      }}
      style={({ pressed }) => ({
        width: 36,
        height: 36,
        borderRadius: 18,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: pressed ? theme.active : 'transparent',
        opacity: enabled ? 1 : 0.4,
      })}
    >
      <AttachGlyph size={20} color={theme.muted} />
    </Press>
  )
}

/** The field's one line: the buttons beside it are this tall. */
const FIELD_LINE = 21
const FIELD_MIN = 36
/** Six lines, then the field scrolls: the page stays in view however long the message. */
const FIELD_MAX = FIELD_LINE * 6 + (FIELD_MIN - FIELD_LINE)

/**
 * The composer, in the session page's dock, written in where it stands: the
 * keyboard lifts the dock, and the page stays in view above it. At rest (B)
 * the field with the picks row under it; while a turn runs (C) one summary
 * chip inside the field, so the controls never sit beside the stop button,
 * until the field is in use and they are wanted again; while the session
 * waits on the reader, the prompt, and what was typed stays in the draft.
 */
export function ComposerDock({
  model,
  ui,
  input,
  focused,
  onFocusChange,
}: {
  model: ComposerModel
  ui: ComposerUi
  input: RefObject<TextInput | null>
  focused: boolean
  onFocusChange: (focused: boolean) => void
}) {
  const theme = usePhoneTheme()
  const fold = composerFold(model, focused)
  const prompt = model.prompt
  const replaced = prompt && prompt.kind !== 'plan'
  const radius = replaced ? 22 : 26
  const { onContentLayout, heightStyle } = useFoldHeight(foldKey(fold, prompt?.requestId ?? null))
  return (
    // The box's height eases only through a fold; the content inside it never animates its layout.
    <Animated.View
      style={[
        { borderRadius: radius, overflow: 'hidden', boxShadow: theme.shadow.rest },
        heightStyle,
      ]}
    >
      <Glass
        strength="strong"
        shadow="none"
        radius={radius}
        style={{ flexGrow: 1 }}
        contentStyle={{
          paddingTop: DOCK_PADDING.top,
          paddingHorizontal: 8,
          paddingBottom: DOCK_PADDING.bottom,
        }}
      >
        <View style={{ gap: 4 }} onLayout={onContentLayout}>
          {prompt?.kind === 'permission' ? (
            <Animated.View key={`p-${prompt.requestId}`} entering={FOLD_IN}>
              <PermissionPrompt prompt={prompt} />
            </Animated.View>
          ) : prompt?.kind === 'question' ? (
            <Animated.View key={`q-${prompt.requestId}`} entering={FOLD_IN}>
              <QuestionPrompt prompt={prompt} />
            </Animated.View>
          ) : (
            <>
              {prompt?.kind === 'plan' ? (
                <Animated.View key={`plan-${prompt.requestId}`} entering={FOLD_IN}>
                  <PlanPrompt prompt={prompt} onRead={() => ui.open({ kind: 'plan' })} />
                </Animated.View>
              ) : null}
              <ImageStrip images={model.images} onRemove={model.removeImage} />
              <View
                style={{
                  flexDirection: 'row',
                  // A long message grows up from the buttons, which stay at its last line.
                  alignItems: 'flex-end',
                  gap: 8,
                  minHeight: FIELD_MIN,
                  paddingVertical: 4,
                  paddingLeft: fold === 'running' ? 0 : 8,
                  paddingRight: 4,
                }}
              >
                {fold === 'running' ? (
                  <Animated.View
                    entering={FOLD_IN}
                    exiting={FOLD_OUT}
                    style={{ minHeight: FIELD_MIN, justifyContent: 'center' }}
                  >
                    <Press
                      accessibilityRole="button"
                      accessibilityLabel={`Model: ${model.picks.modelLabel}. Show the picks`}
                      onPress={() => {
                        tap()
                        input.current?.focus()
                      }}
                      style={({ pressed }) => ({
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 5,
                        paddingVertical: 5,
                        paddingLeft: 7,
                        paddingRight: 9,
                        borderRadius: 999,
                        backgroundColor: pressed ? theme.active : theme.hover,
                      })}
                    >
                      <ProviderMark providerId={model.picks.providerId} size={13} />
                      <AppText
                        variant="text-12-regular"
                        numberOfLines={1}
                        style={{ color: theme.muted, fontSize: 12.5, maxWidth: 110 }}
                      >
                        {model.picks.modelLabel}
                      </AppText>
                    </Press>
                  </Animated.View>
                ) : null}
                <TextInput
                  ref={input}
                  accessibilityLabel="Message"
                  multiline
                  value={model.text}
                  onChangeText={model.setText}
                  onFocus={() => onFocusChange(true)}
                  onBlur={() => onFocusChange(false)}
                  placeholder={model.placeholder}
                  placeholderTextColor={theme.faint}
                  underlineColorAndroid="transparent"
                  cursorColor={theme.fg}
                  selectionColor={theme.active}
                  textAlignVertical="center"
                  style={{
                    flex: 1,
                    minWidth: 0,
                    minHeight: FIELD_MIN,
                    maxHeight: FIELD_MAX,
                    paddingVertical: (FIELD_MIN - FIELD_LINE) / 2,
                    paddingHorizontal: 0,
                    color: theme.fg,
                    fontFamily: 'Geist-Regular',
                    fontSize: 15,
                    lineHeight: FIELD_LINE,
                  }}
                />
                <AttachButton model={model} ui={ui} />
                <PrimaryButton
                  action={model.primary}
                  onSend={() => {
                    // The reply is what comes next: the page takes the room back.
                    Keyboard.dismiss()
                    model.send()
                  }}
                  onStop={model.interrupt}
                />
              </View>
              {fold === 'rest' || prompt?.kind === 'plan' ? (
                <Animated.View
                  entering={FOLD_IN}
                  exiting={FOLD_OUT}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    paddingLeft: 4,
                    paddingRight: 2,
                  }}
                >
                  <Picks model={model} ui={ui} variant="row" />
                </Animated.View>
              ) : null}
              <ComposerNotice model={model} />
              <SyncNotice model={model} />
            </>
          )}
        </View>
      </Glass>
    </Animated.View>
  )
}

const FOLD_TIMING = { duration: 200, easing: Easing.out(Easing.cubic) }

/**
 * The dock box's height through a fold: from its measured height before the
 * change to its measured height after, on the UI thread (`withTiming` on a
 * shared value), the dock told its new height once at the start. See
 * `createFoldDriver` for what counts as a fold.
 */
function useFoldHeight(key: string) {
  const hold = useDockHold()
  const height = useSharedValue(-1)
  const [driver] = useState(() => {
    const ports: FoldPorts = {
      now: () => Date.now(),
      hold: (delta) => holdRef.current?.hold(delta),
      release: () => holdRef.current?.release(),
      set: (to) => {
        cancelAnimation(height)
        height.value = to
      },
      animate: (from, to) => {
        height.value = from
        height.value = withTiming(to, FOLD_TIMING, (finished) => {
          if (finished) runOnJS(finish)()
        })
      },
    }
    const created = createFoldDriver(ports)
    const finish = () => created.onFinished()
    return created
  })
  const holdRef = useRef(hold)
  holdRef.current = hold
  useLayoutEffect(() => {
    driver.onKey(key)
  }, [driver, key])
  // Until the box has measured itself it sizes to its content; from then on
  // its height is always the one set here, never a value left behind.
  const heightStyle = useAnimatedStyle(() => (height.value > 0 ? { height: height.value } : {}))
  const onContentLayout = useCallback(
    // The box's height, padding included: the same box the ease sizes.
    (event: LayoutChangeEvent) =>
      driver.onContentHeight(boxHeightOf(event.nativeEvent.layout.height)),
    [driver],
  )
  return { onContentLayout, heightStyle }
}
