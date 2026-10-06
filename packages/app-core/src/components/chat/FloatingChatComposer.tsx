import { useLayoutEffect, useRef, type ReactNode } from 'react'

/** The dock's height, published on its parent so siblings (the
 * scroll-to-latest button) can sit just above a composer that grows. */
export const COMPOSER_HEIGHT_VAR = '--chat-composer-height'

/** Bottom dock: the composer floats over the transcript, no fade behind it. */
export function FloatingChatComposer({ children }: { children: ReactNode }) {
  const dockRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const dock = dockRef.current
    const host = dock?.parentElement?.parentElement
    if (!dock || !host || typeof ResizeObserver === 'undefined') return
    const publish = () => host.style.setProperty(COMPOSER_HEIGHT_VAR, `${dock.offsetHeight}px`)
    publish()
    const observer = new ResizeObserver(publish)
    observer.observe(dock)
    return () => {
      observer.disconnect()
      host.style.removeProperty(COMPOSER_HEIGHT_VAR)
    }
  }, [])

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 pt-20">
      <div
        ref={dockRef}
        className="pointer-events-auto mx-auto w-full max-w-[48rem] px-4 pb-1.5 pt-0"
      >
        {children}
      </div>
    </div>
  )
}
