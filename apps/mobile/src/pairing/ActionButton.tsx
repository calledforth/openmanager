import type { ReactNode } from 'react'
import { Pressable } from 'react-native'

import { AppText } from '../components/ui/AppText'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { tap } from '../ui/haptics'

/**
 * A full-width action with words, for the few places a button must say what
 * it does (a next step after a refusal, agreeing to a new address). Primary
 * is the theme's action fill; quiet is text on nothing.
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
  tone?: 'primary' | 'quiet'
  icon?: ReactNode
  disabled?: boolean
}) {
  const theme = usePhoneTheme()
  const primary = tone === 'primary'
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={() => {
        tap()
        onPress()
      }}
      style={({ pressed }) => ({
        height: primary ? 52 : 44,
        borderRadius: 16,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        backgroundColor: primary ? (pressed ? theme.actionHover : theme.actionBg) : 'transparent',
        opacity: disabled ? 0.4 : pressed && !primary ? 0.6 : 1,
      })}
    >
      {icon}
      <AppText
        variant={primary ? 'text-16-medium' : 'text-14-medium'}
        style={{ color: primary ? theme.actionFg : theme.muted }}
      >
        {label}
      </AppText>
    </Pressable>
  )
}
