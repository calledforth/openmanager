import { createContext } from 'react'

/** The most of the page a prompt's body may take: the thread stays in view above it. */
export const PROMPT_SHARE = 0.55

/** However short the page, the body keeps this much, and scrolls. */
export const PROMPT_MIN_BODY = 96

/**
 * How tall the page is for the composer, keyboard accounted for: the composer
 * layer as measured (the page's keyboard avoider has already made room for
 * the keyboard), or, before it has measured itself, the window less the
 * keyboard. Never less than a third of the window: a keyboard height that
 * went stale (a hide the platform never reported) must not collapse the
 * prompt.
 */
export function promptRoom({
  layer,
  window,
  keyboard,
}: {
  /** The composer layer's measured height; 0 before it has measured itself. */
  layer: number
  window: number
  keyboard: number
}): number {
  const base = layer > 0 ? Math.min(layer, window) : window - Math.max(0, keyboard)
  return Math.round(Math.max(window / 3, base))
}

/**
 * The prompt body's most height before it scrolls: no more than
 * `PROMPT_SHARE` of the page, but at least `floor` (the heading and the first
 * choices) so they show whole; and never more than the page leaves under its
 * chrome and over the footer, so a floor that cannot fit scrolls rather than
 * pushing the top of the prompt off the screen.
 */
export function promptBodyMax({
  room,
  chrome,
  footer,
  floor,
}: {
  room: number
  /** What the page keeps above the dock: the header, the status line, the dock's padding, the safe areas. */
  chrome: number
  footer: number
  floor: number
}): number {
  const left = room - chrome - footer
  const wanted = Math.max(floor, Math.min(room * PROMPT_SHARE, left))
  return Math.round(Math.max(PROMPT_MIN_BODY, Math.min(left, wanted)))
}

/** The page's height for the composer (see `promptRoom`), from the composer layer. */
export const PromptRoomContext = createContext(0)
