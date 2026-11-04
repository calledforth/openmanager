/**
 * Whether a sheet covers the tab bar. The floating pill is drawn by the tabs
 * navigator beside every tab's screen and above all of them, so a sheet a
 * screen opens rises from the bottom edge underneath it: the pill would sit
 * over the sheet's last rows, and stay pressable. Each open sheet raises the
 * cover while it is mounted, and the pill steps aside until none is open.
 * Pure, so it is tested without React Native.
 */
import { createContext } from 'react'

export function createTabBarCover() {
  let open = 0
  const listeners = new Set<() => void>()
  const emit = () => {
    for (const listener of [...listeners]) listener()
  }
  return {
    covered: () => open > 0,
    /** One sheet opened; the returned function is that sheet closing, once. */
    raise(): () => void {
      open += 1
      if (open === 1) emit()
      let lowered = false
      return () => {
        if (lowered) return
        lowered = true
        open -= 1
        if (open === 0) emit()
      }
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

export type TabBarCover = ReturnType<typeof createTabBarCover>

/** The tabs' cover, for their sheets and the pill; none above the tabs. */
export const TabBarCoverContext = createContext<TabBarCover | null>(null)
