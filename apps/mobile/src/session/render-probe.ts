/**
 * Render counts for the transcript, for measuring how much one streamed
 * token re-renders. Off in every build unless `EXPO_PUBLIC_RENDER_PROBE=1`
 * (Expo inlines the variable, so the call is a no-op otherwise); the probe
 * reads and resets `globalThis.__omRenders`.
 */
const enabled = process.env.EXPO_PUBLIC_RENDER_PROBE === '1'

type Counts = Record<string, number>

export function countRender(name: string): void {
  if (!enabled) return
  const scope = globalThis as { __omRenders?: Counts }
  const counts = (scope.__omRenders ??= {})
  counts[name] = (counts[name] ?? 0) + 1
}
