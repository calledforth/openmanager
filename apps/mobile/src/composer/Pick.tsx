import { ArrowBendUpRightIcon, ClockIcon } from 'phosphor-react-native'
import { forwardRef, useRef, type ReactNode } from 'react'
import { View, type LayoutChangeEvent } from 'react-native'

import { AppText } from '../components/ui/AppText'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { tap } from '../ui/haptics'
import { Press } from '../ui/Press'
import { SendGlyph, StopGlyph } from './icons'
import { FOLLOW_UP_LABEL, meterPercent, pressPrimary, type PrimaryAction } from './model'
import type { FollowUpAction } from '@openmanager/app-core/logic'
import { measure } from './Picks'
import type { PickAnchor } from './ui-state'

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
    /** The model pick's room in the row: it alone gives way to a long name. */
    maxWidth?: number
    onLayout?: (event: LayoutChangeEvent) => void
    onPress: () => void
  }
>(function Pick(
  {
    label,
    accessibilityLabel,
    icon,
    trailing,
    on,
    strong,
    filled,
    disabledReason,
    maxWidth,
    onLayout,
    onPress,
  },
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
      onLayout={onLayout}
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
        // Only the model's name gives way; mode and effort keep their whole labels.
        flexShrink: strong ? 1 : 0,
        minWidth: 0,
        ...(maxWidth !== undefined ? { maxWidth } : null),
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
          style={{ color: ink, fontSize: 12.5, ...(strong ? { flexShrink: 1 } : null) }}
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
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 6,
        flexShrink: 0,
      }}
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
/** What the button is called, by what it does now. */
function primaryLabel(action: Pick<PrimaryAction, 'kind' | 'busy'>): string {
  if (action.kind === 'stop') return 'Stop'
  if (action.busy) return 'Sending'
  return action.kind === 'send' ? 'Send' : FOLLOW_UP_LABEL[action.kind].label
}

/**
 * The send button. While the chat is busy it queues or steers what is typed
 * (a clock, or an arrow bending into the turn), and when the other is
 * possible a long press opens both (`onChoose`), as web's menu beside it.
 */
export function PrimaryButton({
  action,
  size = 36,
  onSend,
  onStop,
  onChoose,
}: {
  action: Omit<PrimaryAction, 'alternate'> & { alternate?: FollowUpAction | null }
  size?: number
  onSend: (action?: FollowUpAction) => void
  onStop: () => void
  /** The long press: both ways to send, standing on the button. */
  onChoose?: (anchor: PickAnchor) => void
}) {
  const theme = usePhoneTheme()
  const button = useRef<View>(null)
  const stop = action.kind === 'stop'
  const active = action.enabled
  const glyph = active ? theme.actionFg : theme.faint
  const choosable = !!action.alternate && !!onChoose && active
  const choose = () => {
    if (!choosable) return
    tap()
    measure(button.current, (anchor) => onChoose!(anchor))
  }
  return (
    <Press
      ref={button}
      accessibilityRole="button"
      accessibilityLabel={primaryLabel(action)}
      accessibilityHint={
        action.reason ??
        (action.kind === 'queue' || action.kind === 'steer'
          ? FOLLOW_UP_LABEL[action.kind].description
          : undefined)
      }
      accessibilityState={{ disabled: !active, busy: action.busy }}
      accessibilityActions={
        choosable ? [{ name: 'longpress', label: 'Choose how to send' }] : undefined
      }
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === 'longpress') choose()
      }}
      disabled={!active}
      hitSlop={6}
      onPress={() => {
        tap()
        pressPrimary(
          { alternate: null, ...action },
          { send: (followUp) => onSend(followUp), interrupt: onStop },
        )
      }}
      onLongPress={choosable ? choose : undefined}
      delayLongPress={350}
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
      ) : action.kind === 'queue' ? (
        <ClockIcon size={size * 0.47} color={glyph} weight="bold" />
      ) : action.kind === 'steer' ? (
        <ArrowBendUpRightIcon size={size * 0.47} color={glyph} weight="bold" />
      ) : (
        <SendGlyph size={size * 0.39} color={glyph} />
      )}
    </Press>
  )
}

/**
 * Stop beside the send button, while a turn runs and the button queues or
 * steers what is typed: a quieter round button with the same square.
 */
export function StopBeside({
  action,
  size = 36,
  onStop,
}: {
  action: Omit<PrimaryAction, 'alternate'>
  size?: number
  onStop: () => void
}) {
  const theme = usePhoneTheme()
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel="Stop"
      accessibilityHint={action.reason ?? undefined}
      accessibilityState={{ disabled: !action.enabled }}
      disabled={!action.enabled}
      hitSlop={6}
      onPress={() => {
        tap()
        onStop()
      }}
      style={({ pressed }) => ({
        width: size,
        height: size,
        borderRadius: size / 2,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: pressed ? theme.active : theme.hover,
        opacity: action.enabled ? 1 : 0.4,
      })}
    >
      <StopGlyph size={size * 0.36} color={theme.muted} />
    </Press>
  )
}
