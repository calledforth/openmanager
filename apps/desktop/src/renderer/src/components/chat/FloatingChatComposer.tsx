import type { ReactNode } from 'react'

/** Bottom dock: Basis-style canvas gradient fade */
export function FloatingChatComposer({ children }: { children: ReactNode }) {
  return (
    <div className="chat-composer-fade pointer-events-none absolute inset-x-0 bottom-0 z-20 pt-28">
      <div className="pointer-events-auto mx-auto w-full max-w-3xl px-4 pb-1.5 pt-0">{children}</div>
    </div>
  )
}
