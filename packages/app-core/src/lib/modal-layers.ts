/**
 * Whether an open dialog that does not hold `element` is laid over the page.
 *
 * A control with a global shortcut (the model or project picker) checks this
 * before it answers a press: with a dialog over it, the press belongs to the
 * dialog, which may hold a copy of the same control (the quick New agent
 * palette has a composer of its own).
 */
export function behindModal(element: Element | null): boolean {
  if (!element || typeof document === 'undefined') return false
  return [...document.querySelectorAll('[role="dialog"][data-state="open"]')].some(
    (dialog) => !dialog.contains(element),
  )
}
