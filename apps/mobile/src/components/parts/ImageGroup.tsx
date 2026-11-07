import { memo, useCallback, useState } from 'react'
import { useWindowDimensions, View, type LayoutChangeEvent } from 'react-native'

import { usePhoneTheme } from '../../theme/ThemeProvider'
import { tap } from '../../ui/haptics'
import { Press } from '../../ui/Press'
import { AppText } from '../ui/AppText'
import { cardRatio, galleryLayout, TILE_RATIO, tileSize, viewerIndexOf } from './image-group'
import { imageKey, ImageTile, type GalleryImage } from './ImagePart'
import { ImageViewer } from './ImageViewer'

export type { GalleryImage } from './ImagePart'

/** Between tiles. */
const GAP = 6
/** A single card is no wider, and no taller, than this. */
const CARD_MAX_WIDTH = 320
const CARD_MAX_HEIGHT = 300
/** The transcript's inset from the screen's sides (`SessionThread`'s content padding). */
const TRANSCRIPT_INSET = 20

/** The width a reply's row has: the window less the transcript's insets. */
export function useTranscriptWidth(): number {
  const { width } = useWindowDimensions()
  return Math.max(160, Math.round(width - TRANSCRIPT_INSET * 2))
}

/**
 * A message's images as one piece, as web groups them: one image as a card
 * of its own at its own ratio, more as a grid of 3:2 tiles (two across for
 * two or four, else three), folded past six behind a "+N" tile. Any tile
 * opens the viewer on that image, the "+N" tile on the first it hides, and
 * the viewer pages through the whole group.
 *
 * `width` is the room the group has; the group measures itself as well, so a
 * row narrower than expected (inside a work group) keeps its tiles in.
 */
export const ImageGroup = memo(function ImageGroup({
  images,
  width,
  align = 'start',
}: {
  images: readonly GalleryImage[]
  width: number
  /** The side the tiles sit on: a reply's start, a prompt's end. */
  align?: 'start' | 'end'
}) {
  const theme = usePhoneTheme()
  const [viewing, setViewing] = useState<number | null>(null)
  const [measured, setMeasured] = useState<number | null>(null)
  // A single card's ratio, from the picture once it has loaded.
  const [ratio, setRatio] = useState<number | null>(null)
  const close = useCallback(() => setViewing(null), [])
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const next = Math.round(event.nativeEvent.layout.width)
    setMeasured((previous) => (previous === next ? previous : next))
  }, [])
  const onNaturalSize = useCallback((w: number, h: number) => {
    const next = cardRatio(w, h)
    setRatio((previous) => (previous !== null && Math.abs(previous - next) < 0.05 ? previous : next))
  }, [])

  const count = images.length
  if (count === 0) return null
  const layout = galleryLayout(count)
  const room = align === 'start' && measured !== null ? Math.min(width, measured) : width
  const viewer =
    viewing !== null ? <ImageViewer images={images} index={viewing} onClose={close} /> : null
  const end = align === 'end'

  if (layout.columns === 1) {
    const shape = ratio ?? TILE_RATIO
    let cardWidth = Math.min(room, CARD_MAX_WIDTH)
    if (cardWidth / shape > CARD_MAX_HEIGHT) cardWidth = Math.round(CARD_MAX_HEIGHT * shape)
    return (
      <View onLayout={onLayout} style={{ alignSelf: end ? 'flex-end' : 'stretch' }}>
        <View style={{ alignItems: end ? 'flex-end' : 'flex-start' }}>
          <ImageTile
            image={images[0]!}
            width={cardWidth}
            height={Math.round(cardWidth / shape)}
            radius={14}
            onPress={() => setViewing(0)}
            onNaturalSize={onNaturalSize}
          />
        </View>
        {viewer}
      </View>
    )
  }

  const tile = tileSize(room, layout.columns, GAP)
  const rowWidth = tile.width * layout.columns + GAP * (layout.columns - 1)
  return (
    <View onLayout={onLayout} style={{ alignSelf: end ? 'flex-end' : 'stretch' }}>
      <View
        style={{
          width: rowWidth,
          flexDirection: 'row',
          flexWrap: 'wrap',
          gap: GAP,
          justifyContent: end ? 'flex-end' : 'flex-start',
          alignSelf: end ? 'flex-end' : 'flex-start',
        }}
      >
        {images.slice(0, layout.shown).map((image, index) => (
          <ImageTile
            key={imageKey(image)}
            image={image}
            width={tile.width}
            height={tile.height}
            onPress={() => setViewing(viewerIndexOf(index, layout))}
          />
        ))}
        {layout.hidden > 0 ? (
          <Press
            accessibilityRole="button"
            accessibilityLabel={`${layout.hidden} more images`}
            accessibilityHint="Opens them full size"
            onPress={() => {
              tap()
              setViewing(viewerIndexOf(layout.shown, layout))
            }}
            style={({ pressed }) => ({
              width: tile.width,
              height: tile.height,
              borderRadius: 10,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: pressed ? theme.active : theme.hover,
            })}
          >
            <AppText variant="text-13-medium" style={{ color: theme.muted }}>
              +{layout.hidden}
            </AppText>
          </Press>
        ) : null}
      </View>
      {viewer}
    </View>
  )
})
