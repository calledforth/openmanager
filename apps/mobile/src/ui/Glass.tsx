import { BlurTargetView, BlurView } from 'expo-blur'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  PixelRatio,
  Platform,
  StyleSheet,
  View,
  type StyleProp,
  type ViewProps,
  type ViewStyle,
} from 'react-native'

import { usePhoneTheme } from '../theme/ThemeProvider'
import {
  glassBlurProps,
  INSIDE_TARGET,
  type GlassTarget,
  type GlassTargetSlot,
} from './glass-target'

export type { GlassTarget } from './glass-target'
export type GlassStrength = 'glass' | 'strong' | 'sheet'
export type GlassShadow = 'float' | 'rest' | 'none'

/**
 * What a Glass here blurs: the content of the layer it floats over, none
 * outside every layer, or `INSIDE_TARGET` within a layer's content (where a
 * Glass must never be: Android's blur would draw itself).
 */
const GlassTargetContext = createContext<GlassTargetSlot>(null)
/** The layer a `GlassContent` belongs to: where it hands its view. */
const LayerContext = createContext<((node: View | null) => void) | null>(null)

/** The target the glass here blurs, for a layer that draws glass somewhere else (the tab bar). */
export function useGlassTarget(): GlassTarget | null {
  const slot = useContext(GlassTargetContext)
  return slot === INSIDE_TARGET ? null : slot
}

/** Glass under this blurs `target`: for glass drawn outside the layer it floats over. */
export function GlassTargetProvider({
  target,
  children,
}: {
  target: GlassTarget | null
  children: ReactNode
}) {
  return <GlassTargetContext.Provider value={target}>{children}</GlassTargetContext.Provider>
}

/**
 * One layer of glass over content: a screen, the pulled-up composer, a
 * camera. Android's blur draws a declared target, and a blur inside the
 * target it draws loops the render tree (the render thread overflows its
 * stack), so a layer is two parts: its `GlassContent`, which is the target
 * and never holds a Glass, and the glass beside it, positioned over it, which
 * blurs it. Sheets and popovers opened over the layer are glass beside it too.
 * A layer inside another layer's content (the camera in the pairing screen)
 * is its own target and blurs only itself.
 *
 * `onTarget` hears the target once it is drawn and `null` when it goes, for
 * glass outside the layer (the tab bar, a sheet over the pulled-up composer).
 */
export function GlassLayer({
  onTarget,
  style,
  children,
  ...props
}: Omit<ViewProps, 'children'> & {
  onTarget?: (target: GlassTarget | null) => void
  children: ReactNode
}) {
  // The view itself, held as state: glass mounted before the content (the
  // header's, which comes first for a screen reader) still gets it.
  const [node, setNode] = useState<View | null>(null)
  const target = useMemo<GlassTarget | null>(() => (node ? { current: node } : null), [node])
  const said = useRef(onTarget)
  said.current = onTarget
  useEffect(() => {
    said.current?.(target)
  }, [target])
  useEffect(() => () => said.current?.(null), [])
  return (
    <LayerContext.Provider value={setNode}>
      <GlassTargetContext.Provider value={target}>
        <View {...props} style={style}>
          {children}
        </View>
      </GlassTargetContext.Provider>
    </LayerContext.Provider>
  )
}

/**
 * The layer's content: what its glass blurs (Android's `BlurTargetView`; a
 * plain view on iOS and web, which blur whatever is behind). It paints the
 * canvas itself, so the blur never sees the window behind the app. No Glass
 * goes in here; floating glass is a sibling, over it.
 */
export function GlassContent({
  background,
  style,
  children,
  ...props
}: Omit<ViewProps, 'children'> & {
  /** Its canvas: the page's background unless said. */
  background?: string
  children?: ReactNode
}) {
  const theme = usePhoneTheme()
  const setNode = useContext(LayerContext)
  const ref = useCallback(
    (view: View | null) => {
      setNode?.(view)
    },
    [setNode],
  )
  return (
    <GlassTargetContext.Provider value={INSIDE_TARGET}>
      <BlurTargetView
        {...props}
        // expo-blur types the ref as an object; a callback is what React passes on.
        ref={ref as never}
        style={[styles.fill, { backgroundColor: background ?? theme.bg }, style]}
      >
        {children}
      </BlurTargetView>
    </GlassTargetContext.Provider>
  )
}

let warned = false

/**
 * The one recipe for everything that floats over content: a blur of what is
 * behind, tinted with the scheme's translucent floating-surface colour, with
 * the float shadow around it. Content scrolls under it and stays legible.
 * The colours are the theme's glass tokens (float-bg at a scheme opacity);
 * the blur itself is per platform, which is why this is a component and not
 * a token. On Android it blurs the content of the layer it floats over (see
 * `GlassLayer`), at the mockups' radius.
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
  const slot = useContext(GlassTargetContext)
  if (__DEV__ && slot === INSIDE_TARGET && !warned) {
    warned = true
    console.error(
      'Glass inside a GlassContent: it would blur its own target. Draw it beside the content, over it.',
    )
  }
  const tint =
    strength === 'glass'
      ? theme.glass
      : strength === 'strong'
        ? theme.glassStrong
        : theme.glassSheet
  const intensity = strength === 'glass' ? 24 : strength === 'strong' ? 28 : 32
  const blur = glassBlurProps(slot, Platform.OS, PixelRatio.get())
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
          {...blur}
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
