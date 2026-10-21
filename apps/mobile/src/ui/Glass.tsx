import { BlurTargetView, BlurView } from 'expo-blur'
import { createContext, useContext, useRef, type ReactNode, type RefObject } from 'react'
import { Platform, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'

import { usePhoneTheme } from '../theme/ThemeProvider'

export type GlassStrength = 'glass' | 'strong' | 'sheet'
export type GlassShadow = 'float' | 'rest' | 'none'

const BlurTargetContext = createContext<RefObject<View | null> | null>(null)

/**
 * Android's blur has to be told what to blur: wrap the content that floats
 * under glass in this (the root layout wraps the whole navigator), and every
 * Glass inside it blurs that. iOS and web blur whatever is behind them and
 * ignore the target.
 */
export function GlassBackdrop({ children }: { children: ReactNode }) {
  const target = useRef<View | null>(null)
  return (
    <BlurTargetContext.Provider value={target}>
      <BlurTargetView ref={target} style={styles.fill}>
        {children}
      </BlurTargetView>
    </BlurTargetContext.Provider>
  )
}

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
  const blurTarget = useContext(BlurTargetContext)
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
          {...(Platform.OS === 'android' && blurTarget
            ? { blurMethod: 'dimezisBlurView' as const, blurTarget }
            : null)}
          style={StyleSheet.absoluteFill}
        />
        <View style={[StyleSheet.absoluteFill, { backgroundColor: tint }]} />
        <View style={contentStyle}>{children}</View>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  clip: { overflow: 'hidden' },
})
