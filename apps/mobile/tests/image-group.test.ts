import { describe, expect, it } from 'vitest'

import {
  cardRatio,
  galleryLayout,
  tileSize,
  viewerIndexOf,
} from '../src/components/parts/image-group'
import { fixturePng } from '../src/session/fixture-images'

describe('a run of images', () => {
  it('lays out as web does: one card, two or four two across, else three', () => {
    expect(galleryLayout(1)).toEqual({ columns: 1, shown: 1, hidden: 0 })
    expect(galleryLayout(2)).toEqual({ columns: 2, shown: 2, hidden: 0 })
    expect(galleryLayout(3)).toEqual({ columns: 3, shown: 3, hidden: 0 })
    expect(galleryLayout(4)).toEqual({ columns: 2, shown: 4, hidden: 0 })
    expect(galleryLayout(5)).toEqual({ columns: 3, shown: 5, hidden: 0 })
    expect(galleryLayout(6)).toEqual({ columns: 3, shown: 6, hidden: 0 })
  })

  it('folds past six: five tiles and the rest behind a +N tile', () => {
    expect(galleryLayout(7)).toEqual({ columns: 3, shown: 5, hidden: 2 })
    expect(galleryLayout(10)).toEqual({ columns: 3, shown: 5, hidden: 5 })
    // The +N tile opens the viewer on the first image it hides.
    expect(viewerIndexOf(4, galleryLayout(10))).toBe(4)
    expect(viewerIndexOf(5, galleryLayout(10))).toBe(5)
  })

  it('sizes tiles 3:2 across the row, the gaps taken out', () => {
    expect(tileSize(350, 3, 6)).toEqual({ width: 112, height: 75 })
    expect(tileSize(350, 2, 6)).toEqual({ width: 172, height: 115 })
  })

  it('keeps a single card near its own ratio, between a portrait and a strip', () => {
    expect(cardRatio(1200, 800)).toBe(1.5)
    expect(cardRatio(400, 1200)).toBe(0.75)
    expect(cardRatio(3000, 500)).toBe(2)
    expect(cardRatio(0, 0)).toBe(1.5)
  })
})

describe('the fixture pictures', () => {
  it('are PNGs of the size asked, each different', () => {
    const a = fixturePng(24, 16, 200, 1)
    const b = fixturePng(24, 16, 20, 2)
    expect(a).not.toBe(b)
    const bytes = Buffer.from(a, 'base64')
    expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(bytes.readUInt32BE(16)).toBe(24)
    expect(bytes.readUInt32BE(20)).toBe(16)
  })
})
