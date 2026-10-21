import type { ReactNode } from 'react'
import { Pressable, type StyleProp, type ViewStyle } from 'react-native'

import { Glass } from './Glass'
import { tap } from './haptics'

/** A round glass button for the header: back, more, compose, mark all seen. */
export function IconButton({
  onPress,
  label,
  size = 36,
  style,
  children,
}: {
  onPress?: () => void
  label: string
  size?: number
  style?: StyleProp<ViewStyle>
  children: ReactNode
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      onPress={() => {
        tap()
        onPress?.()
      }}
      style={({ pressed }) => [{ opacity: pressed ? 0.7 : 1 }, style]}
    >
      <Glass
        radius={size / 2}
        contentStyle={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}
      >
        {children}
      </Glass>
    </Pressable>
  )
}
