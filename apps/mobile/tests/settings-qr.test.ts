import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { encodePairingLink } from '@openmanager/environment-client'

import { darkRuns, qrMatrix, utf8Bytes } from '../src/pairing/qr'

/**
 * The QR the phone draws is read back with ZXing (the WebAssembly reader
 * expo-camera's web scanner uses), rasterised exactly as `QrCode.tsx` lays
 * it out: dark runs per row on white, with a quiet zone. ZXing is not the
 * phone's dependency; it is found through expo-camera's own.
 */

/** Where `name` is installed, as seen from the package at `dir` (its exports may hide package.json). */
function installed(dir: string, name: string): string {
  const entry = createRequire(join(dir, 'package.json')).resolve(name)
  const marker = `node_modules${sep}${name.split('/').join(sep)}`
  return entry.slice(0, entry.lastIndexOf(marker) + marker.length)
}
const zxingDir = installed(
  installed(
    installed(join(dirname(fileURLToPath(import.meta.url)), '..'), 'expo-camera'),
    'barcode-detector',
  ),
  'zxing-wasm',
)

type ZXingReader = {
  prepareZXingModule(options: {
    overrides: { wasmBinary: ArrayBuffer }
    fireImmediately: true
  }): void
  readBarcodes(
    image: { data: Uint8ClampedArray; width: number; height: number; colorSpace: 'srgb' },
    options: { formats: string[] },
  ): Promise<Array<{ text: string; ecLevel: string }>>
}

async function decode(text: string): Promise<{ text: string; ecLevel: string }[]> {
  const reader = (await import(
    pathToFileURL(join(zxingDir, 'dist/es/reader/index.js')).href
  )) as ZXingReader
  const wasm = readFileSync(join(zxingDir, 'dist/reader/zxing_reader.wasm'))
  reader.prepareZXingModule({
    overrides: {
      wasmBinary: wasm.buffer.slice(
        wasm.byteOffset,
        wasm.byteOffset + wasm.byteLength,
      ) as ArrayBuffer,
    },
    fireImmediately: true,
  })
  const { size, modules } = qrMatrix(text)
  const scale = 4
  const quiet = 4
  const width = (size + quiet * 2) * scale
  const data = new Uint8ClampedArray(width * width * 4).fill(255)
  modules.forEach((row, y) => {
    for (const run of darkRuns(row)) {
      for (let x = run.start; x < run.start + run.length; x += 1) {
        for (let dy = 0; dy < scale; dy += 1) {
          for (let dx = 0; dx < scale; dx += 1) {
            const at = (((y + quiet) * scale + dy) * width + (x + quiet) * scale + dx) * 4
            data[at] = data[at + 1] = data[at + 2] = 0
          }
        }
      }
    }
  })
  const found = await reader.readBarcodes(
    { data, width, height: width, colorSpace: 'srgb' },
    { formats: ['QRCode'] },
  )
  return found.map((item) => ({ text: item.text, ecLevel: item.ecLevel }))
}

describe('the pairing QR code', () => {
  it('reads back as the exact pairing link', async () => {
    const link = encodePairingLink('https://app.example.test', {
      route: 'https://desk.cletus.xyz',
      environmentId: 'env_01JABCDEFGHJKMNPQRSTVWXYZ0',
      token: 'ABCDEFGHJKLM',
    })
    expect(await decode(link)).toEqual([{ text: link, ecLevel: 'L' }])
  })

  it('is square, sized by the QR versions, with the finder patterns in three corners', () => {
    const { size, modules } = qrMatrix('https://app.example.test/pair#v=1')
    expect((size - 17) % 4).toBe(0)
    expect(modules).toHaveLength(size)
    const finder = (x: number, y: number) =>
      [0, 1, 2, 3, 4, 5, 6].every((i) => modules[y]![x + i] && modules[y + 6]![x + i])
    expect(finder(0, 0)).toBe(true)
    expect(finder(size - 7, 0)).toBe(true)
    expect(finder(0, size - 7)).toBe(true)
  })

  it('merges each row into dark runs', () => {
    expect(darkRuns([true, true, false, true, false, false, true])).toEqual([
      { start: 0, length: 2 },
      { start: 3, length: 1 },
      { start: 6, length: 1 },
    ])
    expect(darkRuns([false, false])).toEqual([])
  })

  it('encodes text as UTF-8 without the runtime’s TextEncoder', () => {
    expect([...utf8Bytes('a·€😀')]).toEqual([...new TextEncoder().encode('a·€😀')])
  })
})
