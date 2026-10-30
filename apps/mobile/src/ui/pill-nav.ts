/**
 * The pill's geometry and the highlight's motion, as numbers, so they are
 * tested without React Native. The highlight is one fill that slides from
 * the tab it was on to the one tapped, and each icon brightens as the
 * highlight reaches it.
 */
export const TAB_WIDTH = 48
export const TAB_HEIGHT = 44
export const TAB_GAP = 4
export const PILL_PADDING = 6

/** Where the highlight sits for the tab at `index`, from the pill's content edge. */
export function pillOffset(index: number): number {
  return index * (TAB_WIDTH + TAB_GAP)
}

/**
 * How much of the selected look the icon at `index` shows while the
 * highlight is at `position` (fractional mid-slide): 1 under it, 0 a tab
 * away or more.
 */
export function tabEmphasis(position: number, index: number): number {
  'worklet'
  return 1 - Math.min(1, Math.abs(position - index))
}
