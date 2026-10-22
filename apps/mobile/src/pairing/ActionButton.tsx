import type { ReactNode } from 'react'

import { AppText } from '../components/ui/AppText'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { tap } from '../ui/haptics'
import { Press } from '../ui/Press'

/**
 * A full-width action with words, for the few places a button must say what
 * it does (a next step after a refusal, agreeing to a new address, confirming
 * something that cannot be undone). Primary is the theme's action fill,
 * destructive its destructive fill; quiet is text on nothing.
 */
export function ActionButton({
  label,
  onPress,
  tone = 'primary',
  icon,
  disabled,
}: {
  label: string
  onPress: () => void
  tone?: 'primary' | 'quiet' | 'destructive'
  icon?: ReactNode
  disabled?: boolean
}) {
  const theme = usePhoneTheme()
  const filled = tone !== 'quiet'
  const destructive = tone === 'destructive'
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={() => {
        tap()
        onPress()
      }}
      style={({ pressed }) => ({
        height: filled ? 52 : 44,
        borderRadius: 16,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        backgroundColor: destructive
          ? theme.destructive
          : filled
            ? pressed
              ? theme.actionHover
              : theme.actionBg
            : 'transparent',
        opacity: disabled ? 0.4 : pressed && (!filled || destructive) ? 0.75 : 1,
      })}
    >
      {icon}
      <AppText
        variant={filled ? 'text-16-medium' : 'text-14-medium'}
        style={{
          color: destructive ? theme.destructiveFg : filled ? theme.actionFg : theme.muted,
        }}
      >
        {label}
      </AppText>
    </Press>
  )
}
