/**
 * Which view a Glass blurs, and how, kept apart from the views so it can be
 * tested without React Native.
 *
 * Android's blur (expo-blur's dimezis method) draws a declared target, the
 * `BlurTargetView` of the layer the glass floats over. expo-blur names each
 * target by its native view tag, so every layer's target is its own.
 */
import type { RefObject } from 'react'
import type { View } from 'react-native'

/** A layer's content view, as expo-blur's `blurTarget` takes it. */
export type GlassTarget = RefObject<View | null>

/** Marks the inside of a layer's content: a Glass there has nothing it may blur. */
export const INSIDE_TARGET = Symbol('inside a blur target')

export type GlassTargetSlot = GlassTarget | typeof INSIDE_TARGET | null

/** Real blur from Android 12 (the render-node path); the tint alone before it. */
const ANDROID_METHOD = 'dimezisBlurViewSdk31Plus' as const

/**
 * The scale between expo-blur's intensity and the mockups' CSS blur. On
 * Android the render-node blur's radius is `intensity / reduction × 4` px,
 * and a radius r is a Gaussian of sigma 0.57735·r; CSS `blur(Npx)` is a
 * Gaussian of sigma N px, a px being a dp on the phone. So intensity N draws
 * the mockups' `blur(Npx)` when the reduction is 4 × 0.57735 / the density.
 */
export function blurReductionFor(pixelRatio: number): number {
  return (4 * 0.57735) / Math.max(pixelRatio, 1)
}

/**
 * The blur props a Glass passes to expo-blur: on Android, the target and the
 * method only with a target (without one the blur is the tint alone, which
 * is what expo-blur draws by itself); iOS and web blur what is behind and take
 * nothing more.
 */
export function glassBlurProps(slot: GlassTargetSlot, os: string, pixelRatio: number) {
  if (os !== 'android' || slot === null || slot === INSIDE_TARGET) return {}
  return {
    blurTarget: slot,
    blurMethod: ANDROID_METHOD,
    blurReductionFactor: blurReductionFor(pixelRatio),
  }
}

/**
 * The tabs' targets, by tab: the tab bar is drawn by the tabs navigator,
 * beside every tab's screen and inside none, and blurs the one in front.
 * A screen sets its target once it is drawn and clears it when it goes; only
 * the tab bar listens, so a screen's own render never waits on it.
 */
export function createTabTargets() {
  const targets = new Map<string, GlassTarget>()
  const listeners = new Set<() => void>()
  const emit = () => {
    for (const listener of [...listeners]) listener()
  }
  return {
    get: (tab: string): GlassTarget | null => targets.get(tab) ?? null,
    set(tab: string, target: GlassTarget | null) {
      if ((targets.get(tab) ?? null) === target) return
      if (target) targets.set(tab, target)
      else targets.delete(tab)
      emit()
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

export type TabTargets = ReturnType<typeof createTabTargets>
