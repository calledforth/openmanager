import { useMemo } from 'react'
import { PixelRatio, View } from 'react-native'

import { darkRuns, qrMatrix } from './qr'

/** Modules of white around the code, so a camera finds its edges. */
const QUIET = 2

/**
 * A QR code drawn with plain Views: one row per module row, one View per
 * run of dark modules. Dark on white whatever the theme, which is what
 * cameras read best; the module size is a whole number of device pixels, so
 * no seams show between rows.
 */
export function QrCode({ value, size = 208 }: { value: string; size?: number }) {
  const matrix = useMemo(() => qrMatrix(value), [value])
  const modules = matrix.size + QUIET * 2
  const pixel = 1 / PixelRatio.get()
  const cell = Math.max(pixel, Math.floor((size / modules) * PixelRatio.get()) / PixelRatio.get())
  const side = cell * modules
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel="Pairing QR code"
      style={{
        width: side,
        height: side,
        padding: cell * QUIET,
        backgroundColor: '#ffffff',
        borderRadius: 14,
      }}
    >
      {matrix.modules.map((row, y) => (
        <View key={y} style={{ height: cell, width: cell * matrix.size }}>
          {darkRuns(row).map((run) => (
            <View
              key={run.start}
              style={{
                position: 'absolute',
                left: run.start * cell,
                width: run.length * cell,
                top: 0,
                bottom: 0,
                backgroundColor: '#000000',
              }}
            />
          ))}
        </View>
      ))}
    </View>
  )
}
