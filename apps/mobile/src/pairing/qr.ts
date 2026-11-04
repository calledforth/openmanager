import { toQR } from 'toqr'

/**
 * A QR code as a square of modules, for drawing with plain Views: no native
 * module, no SVG. `toqr` is a pure-JS encoder (the one Expo's CLI prints its
 * QR codes with); this reads its flat output into rows and, per row, the runs
 * of dark modules, so a code of ~50 modules a side is drawn with a few
 * hundred Views instead of a few thousand.
 *
 * Error correction L, as web's pairing dialog draws it: the link is long and
 * shown on a clean screen, so the smallest code reads best.
 */
export type QrMatrix = {
  /** Modules per side. */
  size: number
  /** `true` for a dark module, row by row. */
  modules: boolean[][]
}

/** The text's UTF-8 bytes, without relying on the runtime's `TextEncoder`. */
export function utf8Bytes(text: string): Uint8Array {
  const bytes: number[] = []
  for (const char of text) {
    const code = char.codePointAt(0)!
    if (code < 0x80) bytes.push(code)
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      )
    }
  }
  return Uint8Array.from(bytes)
}

/** toqr's error-correction levels, by its own numbering (the QR format bits). */
const EC_LOW = 1

export function qrMatrix(text: string): QrMatrix {
  const flat = toQR(utf8Bytes(text), EC_LOW as never)
  const size = Math.round(Math.sqrt(flat.length))
  if (size * size !== flat.length) throw new Error('The QR encoder answered a non-square code.')
  const modules: boolean[][] = []
  for (let y = 0; y < size; y += 1) {
    const row: boolean[] = []
    for (let x = 0; x < size; x += 1) row.push(flat[y * size + x] === 1)
    modules.push(row)
  }
  return { size, modules }
}

/** One row's dark runs: where each starts and how many modules it spans. */
export type QrRun = { start: number; length: number }

export function darkRuns(row: readonly boolean[]): QrRun[] {
  const runs: QrRun[] = []
  let start = -1
  for (let x = 0; x <= row.length; x += 1) {
    const dark = x < row.length && row[x]
    if (dark && start < 0) start = x
    if (!dark && start >= 0) {
      runs.push({ start, length: x - start })
      start = -1
    }
  }
  return runs
}
