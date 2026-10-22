import { memo, useMemo } from 'react'
import { PixelRatio, Text, View } from 'react-native'

import { darkRuns, qrMatrix, type QrMatrix } from './qr'

/** Modules of white around the code, so a camera finds its edges. */
export const QR_QUIET_MODULES = 2

/** What shows instead of a code when the link is too long for one. */
export const QR_TOO_LONG = 'Too long for a QR code — send the link instead'

function encode(value: string): QrMatrix | null {
  try {
    return qrMatrix(value)
  } catch {
    // Past the largest QR code (a very long route): the link is still there to copy.
    return null
  }
}

/**
 * A QR code drawn with plain Views: one row per module row, one View per
 * run of dark modules. Dark on white whatever the theme (the only fixed
 * colours on the phone), which is what cameras read best; the module size is
 * a whole number of device pixels, so no seams show between rows. The tree
 * is built once per link and size: a countdown ticking beside it does not
 * rebuild it.
 */
export const QrCode = memo(function QrCode({
  value,
  size = 208,
}: {
  value: string
  size?: number
}) {
  const ratio = PixelRatio.get()
  const matrix = useMemo(() => encode(value), [value])
  const drawn = useMemo(() => {
    if (!matrix) return null
    const modules = matrix.size + QR_QUIET_MODULES * 2
    const cell = Math.max(1, Math.floor((size / modules) * ratio)) / ratio
    const rows = matrix.modules.map((row, y) => (
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
    ))
    return { side: cell * modules, padding: cell * QR_QUIET_MODULES, rows }
  }, [matrix, size, ratio])

  if (!drawn) {
    return (
      <View
        accessible
        accessibilityRole="text"
        style={{
          width: size,
          paddingVertical: 28,
          paddingHorizontal: 20,
          borderRadius: 14,
          backgroundColor: '#ffffff',
          alignItems: 'center',
        }}
      >
        <Text
          style={{
            fontFamily: 'Geist-Medium',
            fontSize: 14,
            lineHeight: 20,
            color: '#000000',
            textAlign: 'center',
          }}
        >
          {QR_TOO_LONG}
        </Text>
      </View>
    )
  }
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel="Pairing QR code"
      style={{
        width: drawn.side,
        height: drawn.side,
        padding: drawn.padding,
        backgroundColor: '#ffffff',
        borderRadius: 14,
      }}
    >
      {drawn.rows}
    </View>
  )
})
