import type { ReactNode } from 'react'

/** Bottom dock: the composer floats over the transcript, no fade behind it. */
export function FloatingChatComposer({ children }: { children: ReactNode }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 pt-20">
      <div className="pointer-events-auto mx-auto w-full max-w-[48rem] px-4 pb-1.5 pt-0">
        {children}
      </div>
    </div>
  )
}
