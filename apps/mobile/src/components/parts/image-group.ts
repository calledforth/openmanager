/**
 * How a run of images lays out, after web's `GeneratedImages`: one image
 * keeps a card of its own; two or four sit two across; anything else three
 * across; past six tiles the grid folds, five tiles and a "+N" tile for the
 * rest. Pure, so the layout is tested without a screen.
 */

/** How many tiles a folded grid shows, the "+N" tile counted. */
export const GALLERY_VISIBLE = 6

/** The grid's tile ratio (web's `aspect-[3/2]`). */
export const TILE_RATIO = 3 / 2

export interface GalleryLayout {
  columns: 1 | 2 | 3
  /** How many images get a tile of their own. */
  shown: number
  /** How many sit behind the "+N" tile; 0 when every image is shown. */
  hidden: number
}

export function galleryLayout(count: number): GalleryLayout {
  if (count <= 1) return { columns: 1, shown: Math.max(count, 0), hidden: 0 }
  const columns = count === 2 || count === 4 ? 2 : 3
  if (count <= GALLERY_VISIBLE) return { columns, shown: count, hidden: 0 }
  return { columns, shown: GALLERY_VISIBLE - 1, hidden: count - (GALLERY_VISIBLE - 1) }
}

/** A grid tile's size for a row `width` wide, `gap` between tiles. */
export function tileSize(width: number, columns: number, gap: number) {
  const side = Math.max(0, Math.floor((width - gap * (columns - 1)) / columns))
  return { width: side, height: Math.round(side / TILE_RATIO) }
}

/** The ratio a single image's card keeps: its own, held between a tall portrait and a wide strip. */
export function cardRatio(width: number, height: number): number {
  if (!(width > 0) || !(height > 0)) return TILE_RATIO
  return Math.min(2, Math.max(0.75, width / height))
}

/**
 * Where a tap lands the viewer: the tile's own image, or, on the "+N" tile,
 * the first image it stands for.
 */
export function viewerIndexOf(tile: number, layout: GalleryLayout): number {
  return tile < layout.shown ? tile : layout.shown
}
