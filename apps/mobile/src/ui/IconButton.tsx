import type { ReactNode } from 'react'
import { View, type StyleProp, type ViewStyle } from 'react-native'

import { usePhoneTheme } from '../theme/ThemeProvider'
import { Glass } from './Glass'
import { tap } from './haptics'
import { Press } from './Press'

/**
 * A round button: in glass where it floats over content (back, more,
 * compose, jump to latest), or a fill where it sits in the content itself
 * (`surface="fill"`, a try-again on a page), since glass in a layer's content
 * would blur itself.
 */
export function IconButton({
  onPress,
  label,
  size = 36,
  surface = 'glass',
  style,
  children,
}: {
  onPress?: () => void
  label: string
  size?: number
  surface?: 'glass' | 'fill'
  style?: StyleProp<ViewStyle>
  children: ReactNode
}) {
  const theme = usePhoneTheme()
  const face = {
    width: size,
    height: size,
    alignItems: 'center',
    justifyContent: 'center',
  } as const
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      onPress={() => {
        tap()
        onPress?.()
      }}
      style={({ pressed }) => [surface === 'glass' ? { opacity: pressed ? 0.7 : 1 } : null, style]}
    >
      {({ pressed }) =>
        surface === 'glass' ? (
          <Glass radius={size / 2} contentStyle={face}>
            {children}
          </Glass>
        ) : (
          <View
            style={[
              face,
              { borderRadius: size / 2, backgroundColor: pressed ? theme.active : theme.hover },
            ]}
          >
            {children}
          </View>
        )
      }
    </Press>
  )
}
