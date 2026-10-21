import { LinearGradient } from 'expo-linear-gradient'
import type { ReactNode } from 'react'
import { Text, View, type StyleProp, type ViewStyle } from 'react-native'
import { withAlpha } from '@openmanager/app-core/lib/theme-tokens'

import { AppText } from '../components/ui/AppText'
import { usePhoneTheme } from '../theme/ThemeProvider'

/** The big title of a top-level screen, with the environment line under it. */
export function BigTitle({
  title,
  count,
  trailing,
  environment,
}: {
  title: string
  count?: number
  trailing?: ReactNode
  environment?: { label: string; detail?: string; connected: boolean } | null
}) {
  const theme = usePhoneTheme()
  return (
    <View className="px-5">
      <View className="flex-row items-center justify-between" style={{ height: 44 }}>
        <View className="flex-row items-baseline gap-2.5">
          <Text
            style={{
              fontFamily: 'Geist-SemiBold',
              fontSize: 28,
              letterSpacing: -0.5,
              color: theme.fg,
            }}
          >
            {title}
          </Text>
          {count !== undefined ? (
            <AppText variant="text-14-medium" style={{ color: theme.faint }}>
              {count}
            </AppText>
          ) : null}
        </View>
        <View className="flex-row gap-2.5">{trailing}</View>
      </View>
      {environment ? (
        <View className="mt-1 flex-row items-center gap-1.5">
          <View
            style={{
              width: 7,
              height: 7,
              borderRadius: 4,
              backgroundColor: environment.connected ? theme.status.done : theme.faint,
            }}
          />
          <AppText variant="text-13-regular" style={{ color: theme.muted }}>
            {environment.label}
          </AppText>
          {environment.detail ? (
            <AppText variant="text-13-regular" style={{ color: theme.faint }}>
              · {environment.detail}
            </AppText>
          ) : null}
        </View>
      ) : null}
    </View>
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

/** A soft fade at the bottom so rows run under the floating nav. */
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
