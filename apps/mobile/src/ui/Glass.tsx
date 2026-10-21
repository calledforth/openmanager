import { BlurView } from 'expo-blur'
import type { ReactNode } from 'react'
import { Platform, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'

import { usePhoneTheme } from '../theme/ThemeProvider'

export type GlassStrength = 'glass' | 'strong' | 'sheet'
export type GlassShadow = 'float' | 'rest' | 'none'

/**
 * The one recipe for everything that floats over content: a blur of what is
 * behind, tinted with the scheme's translucent floating-surface colour, with
 * the float shadow around it. Content scrolls under it and stays legible.
 * The colours are the theme's glass tokens (float-bg at a scheme opacity);
 * the blur itself is per platform, which is why this is a component and not
 * a token.
 */
export function Glass({
  strength = 'glass',
  shadow = 'rest',
  radius = 999,
  style,
  contentStyle,
  children,
}: {
  strength?: GlassStrength
  shadow?: GlassShadow
  radius?: number
  style?: StyleProp<ViewStyle>
  contentStyle?: StyleProp<ViewStyle>
  children?: ReactNode
}) {
  const theme = usePhoneTheme()
  const tint =
    strength === 'glass'
      ? theme.glass
      : strength === 'strong'
        ? theme.glassStrong
        : theme.glassSheet
  const intensity = strength === 'glass' ? 24 : strength === 'strong' ? 28 : 32
  return (
    <View
      style={[
        { borderRadius: radius },
        shadow !== 'none'
          ? { boxShadow: shadow === 'float' ? theme.shadow.float : theme.shadow.rest }
          : null,
        style,
      ]}
    >
      <View style={[styles.clip, { borderRadius: radius }]}>
        <BlurView
          intensity={intensity}
          tint={theme.colorScheme === 'dark' ? 'dark' : 'light'}
          experimentalBlurMethod={Platform.OS === 'android' ? 'dimezisBlurView' : undefined}
          style={StyleSheet.absoluteFill}
        />
        <View style={[StyleSheet.absoluteFill, { backgroundColor: tint }]} />
        <View style={contentStyle}>{children}</View>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  clip: { overflow: 'hidden' },
})
