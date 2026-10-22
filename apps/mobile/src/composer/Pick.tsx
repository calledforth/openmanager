import { forwardRef, type ReactNode } from 'react'
import { View } from 'react-native'

import { AppText } from '../components/ui/AppText'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { tap } from '../ui/haptics'
import { Press } from '../ui/Press'
import { SendGlyph, StopGlyph } from './icons'
import { meterPercent, type PrimaryAction } from './model'

/**
 * One pick in the composer's row or tray: an icon, a short label, a fill
 * when pressed or open (`on`). `filled` is the tray's look (a resting fill,
 * ink text); `strong` is the model pick's ink. A pick that cannot be used
 * says why to a screen reader and dims.
 */
export const Pick = forwardRef<
  View,
  {
    label?: string
    accessibilityLabel: string
    icon?: ReactNode
    trailing?: ReactNode
    on?: boolean
    strong?: boolean
    filled?: boolean
    disabledReason?: string | null
    onPress: () => void
  }
>(function Pick(
  { label, accessibilityLabel, icon, trailing, on, strong, filled, disabledReason, onPress },
  ref,
) {
  const theme = usePhoneTheme()
  const disabled = !!disabledReason
  const ink = on || strong || filled ? theme.fg : theme.muted
  return (
    <Press
      ref={ref}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={disabledReason ?? undefined}
      accessibilityState={{ disabled, expanded: on }}
      disabled={disabled}
      hitSlop={4}
      onPress={() => {
        tap()
        onPress()
      }}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        paddingVertical: 5,
        paddingHorizontal: label ? 9 : 7,
        borderRadius: 999,
        opacity: disabled ? 0.45 : 1,
        backgroundColor:
          on || (pressed && !disabled) ? theme.active : filled ? theme.hover : 'transparent',
      })}
    >
      {icon}
      {label ? (
        <AppText
          variant="text-12-regular"
          numberOfLines={1}
          style={{ color: ink, fontSize: 12.5, maxWidth: 132 }}
        >
          {label}
        </AppText>
      ) : null}
      {trailing}
    </Press>
  )
})

/** The context meter: how full the window is, a number and a short bar. */
export function ContextMeter({ percent }: { percent: number }) {
  const theme = usePhoneTheme()
  const shown = meterPercent(percent)
  const tone = shown >= 95 ? theme.status.error : shown >= 80 ? theme.status.needs : theme.muted
  return (
    <View
      accessible
      accessibilityLabel={`Context ${shown}% full`}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 6 }}
    >
      <AppText variant="text-11-regular" style={{ color: theme.faint, fontSize: 11.5 }}>
        {`${shown}%`}
      </AppText>
      <View
        style={{
          width: 34,
          height: 3,
          borderRadius: 2,
          backgroundColor: theme.active,
          overflow: 'hidden',
        }}
      >
        <View style={{ width: `${shown}%`, height: '100%', backgroundColor: tone }} />
      </View>
    </View>
  )
}

/**
 * Send and stop, one button. Disabled (a quiet fill, faint glyph) with its
 * reason for a screen reader; the reason is also said under the field.
 */
export function PrimaryButton({
  action,
  size = 36,
  onSend,
  onStop,
}: {
  action: PrimaryAction
  size?: number
  onSend: () => void
  onStop: () => void
}) {
  const theme = usePhoneTheme()
  const stop = action.kind === 'stop'
  const active = action.enabled
  const glyph = active ? theme.actionFg : theme.faint
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel={stop ? 'Stop' : action.busy ? 'Sending' : 'Send'}
      accessibilityHint={action.reason ?? undefined}
      accessibilityState={{ disabled: !active, busy: action.busy }}
      disabled={!active}
      hitSlop={6}
      onPress={() => {
        tap()
        if (stop) onStop()
        else onSend()
      }}
      style={({ pressed }) => ({
        width: size,
        height: size,
        borderRadius: size / 2,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: active ? (pressed ? theme.actionHover : theme.actionBg) : theme.hover,
        opacity: action.busy ? 0.6 : 1,
      })}
    >
      {stop ? (
        <StopGlyph size={size * 0.39} color={glyph} />
      ) : (
        <SendGlyph size={size * 0.39} color={glyph} />
      )}
    </Press>
  )
}
