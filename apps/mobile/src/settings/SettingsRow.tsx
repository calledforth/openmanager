import { CaretRightIcon } from 'phosphor-react-native'
import type { ReactNode } from 'react'
import { View } from 'react-native'

import { AppText } from '../components/ui/AppText'
import type { PhoneConnectionTone } from '../environment/connection-ui'
import type { PhoneTheme } from '../theme/tokens'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { tap } from '../ui/haptics'
import { Press } from '../ui/Press'

/** The colour of a state's dot. Theme status colours only. */
export function toneColor(theme: PhoneTheme, tone: PhoneConnectionTone): string {
  switch (tone) {
    case 'ok':
      return theme.status.done
    case 'working':
      return theme.status.working
    case 'warn':
      return theme.status.needs
    case 'error':
      return theme.status.error
    case 'idle':
      return theme.faint
  }
}

export function Dot({ color, size = 8 }: { color: string; size?: number }) {
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />
  )
}

/** A small rounded tag at the end of a row: "in use", "here", "you". */
export function Pill({ children, tone }: { children: string; tone?: 'warn' | 'strong' }) {
  const theme = usePhoneTheme()
  return (
    <View
      style={{
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 999,
        backgroundColor: tone === 'strong' ? theme.active : theme.hover,
      }}
    >
      <AppText
        variant="text-12-regular"
        style={{
          color: tone === 'warn' ? theme.status.needs : tone === 'strong' ? theme.fg : theme.muted,
        }}
      >
        {children}
      </AppText>
    </View>
  )
}

/**
 * One row of a settings list: an icon on a fill, a title and a line under
 * it, and whatever belongs at the end. Fills, not borders: the pressed state
 * is the hover fill, a selected row the active fill. A row with `onPress`
 * shows a caret unless it has its own trailing element; a row without one is
 * not a button at all.
 */
export function SettingsRow({
  icon,
  title,
  sub,
  trailing,
  selected,
  danger,
  onPress,
  accessibilityLabel,
  raised,
}: {
  icon?: ReactNode
  title: string
  sub?: ReactNode
  trailing?: ReactNode
  selected?: boolean
  danger?: boolean
  onPress?: () => void
  accessibilityLabel?: string
  /** The row sits on a filled panel: its icon tile and pressed state use the stronger fill. */
  raised?: boolean
}) {
  const theme = usePhoneTheme()
  const body = (pressed: boolean) => (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 12,
        paddingVertical: 11,
        borderRadius: 12,
        backgroundColor:
          selected || (raised && pressed) ? theme.active : pressed ? theme.hover : 'transparent',
      }}
    >
      {icon !== undefined ? (
        <View
          style={{
            width: 32,
            height: 32,
            borderRadius: 9,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: icon === null ? 'transparent' : raised ? theme.active : theme.hover,
          }}
        >
          {icon}
        </View>
      ) : null}
      <View style={{ flex: 1, minWidth: 0 }}>
        <AppText
          variant="text-14-medium"
          numberOfLines={1}
          style={{ color: danger ? theme.status.error : theme.fg, fontSize: 15 }}
        >
          {title}
        </AppText>
        {typeof sub === 'string' ? (
          <AppText
            variant="text-12-regular"
            numberOfLines={2}
            style={{ color: theme.muted, marginTop: 2 }}
          >
            {sub}
          </AppText>
        ) : sub ? (
          <View style={{ marginTop: 2 }}>{sub}</View>
        ) : null}
      </View>
      {trailing ?? (onPress ? <CaretRightIcon size={14} color={theme.faint} /> : null)}
    </View>
  )
  if (!onPress) return body(false)
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      onPress={() => {
        tap()
        onPress()
      }}
    >
      {({ pressed }) => body(pressed)}
    </Press>
  )
}
