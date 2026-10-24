import { createContext } from 'react'

/** The most of the page a prompt's body may take: the thread stays in view above it. */
export const PROMPT_SHARE = 0.55

/**
 * How tall the page is for the composer, keyboard accounted for: the composer
 * layer as measured, or the window less the keyboard, whichever is shorter
 * (the page's keyboard avoider may or may not have shrunk the layer already).
 * Never less than a third of the window: a keyboard height that went stale
 * (a hide the platform never reported) must not collapse the prompt.
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
  const base = layer > 0 ? Math.min(layer, window) : window
  return Math.max(Math.round(window / 3), Math.min(base, window - Math.max(0, keyboard)))
}

/**
 * The prompt body's most height before it scrolls: no more than
 * `PROMPT_SHARE` of the page, and no more than the page leaves under its
 * chrome and over the footer, but never less than `floor` (the heading and
 * the first choices), which always shows whole.
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
  const share = room * PROMPT_SHARE
  const left = room - chrome - footer
  return Math.max(floor, Math.round(Math.min(share, left)))
}

/** The page's height for the composer (see `promptRoom`), from the composer layer. */
export const PromptRoomContext = createContext(0)
