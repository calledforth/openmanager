import { LinearGradient } from 'expo-linear-gradient'
import type { ReactNode } from 'react'
import { Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native'
import { withAlpha } from '@openmanager/app-core/lib/theme-tokens'

import { AppText } from '../components/ui/AppText'
import { usePhoneTheme } from '../theme/ThemeProvider'

/**
 * The title of a top-level page (the home, Settings): one compact line, so
 * the views or the controls beside it share its row.
 */
export function PageTitle({ children, style }: { children: string; style?: StyleProp<TextStyle> }) {
  const theme = usePhoneTheme()
  return (
    <Text
      accessibilityRole="header"
      style={[
        { fontFamily: 'Geist-SemiBold', fontSize: 22, letterSpacing: -0.3, color: theme.fg },
        style,
      ]}
    >
      {children}
    </Text>
  )
}

/** The small caps label above a group of rows. */
export function SectionLabel({ children, trailing }: { children: string; trailing?: ReactNode }) {
  const theme = usePhoneTheme()
  return (
    <View className="flex-row items-center px-3 pb-1 pt-3.5">
      <AppText variant="text-11-medium" style={{ color: theme.faint, letterSpacing: 0.3 }}>
        {children.toUpperCase()}
      </AppText>
      <View className="ml-auto">{trailing}</View>
    </View>
  )
}

/** A soft fade at the bottom so rows run under the floating dock. */
export function FadeOut({
  height = 150,
  style,
}: {
  height?: number
  style?: StyleProp<ViewStyle>
}) {
  const theme = usePhoneTheme()
  return (
    <LinearGradient
      pointerEvents="none"
      colors={[withAlpha(theme.bg, 0), withAlpha(theme.bg, 0.55)]}
      style={[{ position: 'absolute', left: 0, right: 0, bottom: 0, height }, style]}
    />
  )
}
