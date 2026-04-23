import type { ReactNode } from 'react'

/**
 * Bottom dock: gradient scrim + pointer-events passthrough so the thread scrolls underneath
 * (reference: absolute bottom-0, pt-28, pointer-events-none; inner max-w column pointer-events-auto).
 */
export function FloatingChatComposer({ children }: { children: ReactNode }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-card/40 via-card/15 to-transparent pt-28">
      <div className="mx-auto w-full max-w-3xl px-4 pb-1.5 pt-0 pointer-events-auto">{children}</div>
    </div>
  )
}
