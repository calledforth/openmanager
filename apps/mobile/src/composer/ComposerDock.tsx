import { View } from 'react-native'
import Animated, { Easing, FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated'

import { AppText } from '../components/ui/AppText'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { Glass } from '../ui/Glass'
import { tap } from '../ui/haptics'
import { Press } from '../ui/Press'
import { ProviderMark } from '../ui/ProviderMark'
import { AttachGlyph } from './icons'
import { ImageStrip } from './ImageStrip'
import { composerFold, type ComposerModel } from './model'
import { PrimaryButton } from './Pick'
import { Picks } from './Picks'
import { PermissionPrompt, PlanPrompt, QuestionPrompt } from './Prompts'
import type { ComposerUi } from './ui-state'

/**
 * The fold, B ⇄ C: the composer's box eases to its new height and the picks
 * row and summary chip cross-fade. Reanimated layout animations, so they run
 * on the UI thread, once per change of the session's state (a turn starting
 * or ending, a request arriving), never per token.
 */
export const FOLD = LinearTransition.duration(200).easing(Easing.out(Easing.cubic))
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

/** The round attach button in the field: the camera, or why images cannot go. */
export function AttachButton({ model, ui }: { model: ComposerModel; ui: ComposerUi }) {
  const theme = usePhoneTheme()
  const { enabled, reason } = model.attach
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel="Attach a photo"
      accessibilityHint={reason ?? undefined}
      accessibilityState={{ disabled: !enabled }}
      disabled={!enabled}
      hitSlop={4}
      onPress={() => {
        tap()
        ui.open({ kind: 'camera' })
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

/**
 * The docked composer, in the session page's dock: at rest (B) the field
 * with the picks row under it; while a turn runs (C) one summary chip inside
 * the field, so the controls never sit beside the stop button; while the
 * session waits on the reader, the prompt. Tapping the field pulls the
 * composer up to write.
 */
export function ComposerDock({ model, ui }: { model: ComposerModel; ui: ComposerUi }) {
  const theme = usePhoneTheme()
  const fold = composerFold(model)
  const prompt = model.prompt
  const replaced = prompt && prompt.kind !== 'plan'
  return (
    <Animated.View layout={FOLD}>
      <Glass
        strength="strong"
        shadow="rest"
        radius={replaced ? 22 : 26}
        contentStyle={{ paddingTop: 6, paddingHorizontal: 8, paddingBottom: 8, gap: 4 }}
      >
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
                alignItems: 'center',
                gap: 8,
                minHeight: 36,
                paddingVertical: 4,
                paddingLeft: fold === 'running' ? 0 : 8,
                paddingRight: 4,
              }}
            >
              {fold === 'running' ? (
                <Animated.View entering={FOLD_IN} exiting={FOLD_OUT}>
                  <Press
                    accessibilityRole="button"
                    accessibilityLabel={`Model: ${model.picks.modelLabel}. Pull up the composer`}
                    onPress={() => {
                      tap()
                      ui.expand()
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
              <Press
                accessibilityRole="button"
                accessibilityLabel={model.text ? `Message: ${model.text}` : 'Write a message'}
                onPress={() => {
                  tap()
                  ui.expand()
                }}
                style={{ flex: 1, minHeight: 28, justifyContent: 'center' }}
              >
                <AppText
                  variant="text-14-regular"
                  numberOfLines={3}
                  style={{
                    color: model.text ? theme.fg : theme.faint,
                    fontSize: 15,
                    lineHeight: 21,
                  }}
                >
                  {model.text || model.placeholder}
                </AppText>
              </Press>
              <AttachButton model={model} ui={ui} />
              <PrimaryButton action={model.primary} onSend={model.send} onStop={model.interrupt} />
            </View>
            {fold === 'rest' || prompt?.kind === 'plan' ? (
              <Animated.View
                entering={FOLD_IN}
                exiting={FOLD_OUT}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 4,
                  paddingLeft: 4,
                  paddingRight: 2,
                }}
              >
                <Picks model={model} ui={ui} variant="row" />
              </Animated.View>
            ) : null}
            <ComposerNotice model={model} />
          </>
        )}
      </Glass>
    </Animated.View>
  )
}
