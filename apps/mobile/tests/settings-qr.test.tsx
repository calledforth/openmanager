// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { act, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodePairingLink } from '@openmanager/environment-client'

/**
 * The QR the phone draws is read back with ZXing (the WebAssembly reader
 * expo-camera's web scanner uses). The raster comes from `QrCode.tsx`
 * itself: it is mounted with React Native's View and Text standing in as
 * plain elements carrying their style, at a device pixel ratio, and each
 * View's box is painted at device pixels, rounded corners included, on the
 * sheet around it (light and dark). ZXing is not the phone's dependency; it
 * is found through expo-camera's own.
 */
type Style = Record<string, number | string>
let ratio = 1
vi.mock('react-native', () => {
  const flat = (style: unknown): Style =>
    Array.isArray(style)
      ? Object.assign({}, ...style.map(flat))
      : ((style as Style | undefined) ?? {})
  const box =
    (tag: string) =>
    ({ style, children }: { style?: unknown; children?: ReactNode }) => (
      <div data-tag={tag} data-style={JSON.stringify(flat(style))}>
        {children}
      </div>
    )
  return { View: box('view'), Text: box('text'), PixelRatio: { get: () => ratio } }
})

// Counted, so a render that rebuilds the code's tree shows.
const runCalls = { count: 0 }
vi.mock('../src/pairing/qr', async (original) => {
  const actual = await original<typeof import('../src/pairing/qr')>()
  return {
    ...actual,
    darkRuns: (row: readonly boolean[]) => {
      runCalls.count += 1
      return actual.darkRuns(row)
    },
  }
})

const { QrCode, QR_QUIET_MODULES, QR_TOO_LONG } = await import('../src/pairing/QrCode')
const { darkRuns, qrMatrix, utf8Bytes } = await import('../src/pairing/qr')

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
let reader: ZXingReader | null = null
async function zxing(): Promise<ZXingReader> {
  if (reader) return reader
  reader = (await import(
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
  return reader
}

let host: HTMLElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

const styleOf = (element: Element): Style => JSON.parse(element.getAttribute('data-style') ?? '{}')
const num = (value: number | string | undefined) => (typeof value === 'number' ? value : 0)

/**
 * Paint what `QrCode` laid out, at device pixels: the white rounded card,
 * each row stacked under the padding, each dark run where its `left` and
 * `width` put it, on `around` (the sheet) with `margin` pixels of it.
 */
function rasterise(card: Element, around: number, margin = 24) {
  const style = styleOf(card)
  const side = num(style.width)
  const pad = num(style.padding)
  const radius = num(style.borderRadius)
  const px = (dp: number) => Math.round(dp * ratio)
  const size = px(side) + margin * 2
  const data = new Uint8ClampedArray(size * size * 4)
  const paint = (x: number, y: number, value: number) => {
    const at = (y * size + x) * 4
    data[at] = data[at + 1] = data[at + 2] = value
    data[at + 3] = 255
  }
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) paint(x, y, around)
  // The card, its corners rounded as `borderRadius` clips them.
  const r = radius * ratio
  const w = px(side)
  for (let y = 0; y < w; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const cx = Math.min(Math.max(x + 0.5, r), w - r)
      const cy = Math.min(Math.max(y + 0.5, r), w - r)
      if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r) paint(margin + x, margin + y, 255)
    }
  }
  let top = pad
  for (const row of [...card.children]) {
    const height = num(styleOf(row).height)
    for (const run of [...row.children]) {
      const s = styleOf(run)
      expect(s.backgroundColor).toBe('#000000')
      const x0 = px(pad + num(s.left))
      const x1 = px(pad + num(s.left) + num(s.width))
      for (let y = px(top); y < px(top + height); y += 1) {
        for (let x = x0; x < x1; x += 1) paint(margin + x, margin + y, 0)
      }
    }
    top += height
  }
  return { data, width: size, height: size, colorSpace: 'srgb' as const }
}

const LINK = encodePairingLink('https://app.example.test', {
  route: 'https://desk.cletus.xyz',
  environmentId: 'env_01JABCDEFGHJKMNPQRSTVWXYZ0',
  token: 'ABCDEFGHJKLM',
})

describe('the pairing QR code as the phone draws it', () => {
  for (const at of [1, 2.625, 3.5]) {
    it(`reads back as the exact link at pixel ratio ${at}, on a light and a dark sheet`, async () => {
      ratio = at
      act(() => root.render(<QrCode value={LINK} />))
      const card = host.querySelector('[data-tag="view"]')!
      // Whole device pixels per module, so rows meet without seams.
      const firstRow = card.children[0]!
      const cell = num(styleOf(firstRow).height)
      expect(Number.isInteger(Math.round(cell * at * 1e6) / 1e6)).toBe(true)
      expect(num(styleOf(card).padding)).toBeCloseTo(cell * QR_QUIET_MODULES)
      const zx = await zxing()
      for (const around of [252, 28]) {
        const found = await zx.readBarcodes(rasterise(card, around), { formats: ['QRCode'] })
        expect(found.map((item) => [item.text, item.ecLevel])).toEqual([[LINK, 'L']])
      }
    })
  }

  it('says the link is too long instead of failing when it is past any QR code', () => {
    ratio = 2
    const long = `https://app.example.test/pair#${'x'.repeat(4000)}`
    act(() => root.render(<QrCode value={long} />))
    expect(host.textContent).toBe(QR_TOO_LONG)
  })

  it('is not rebuilt when what is around it renders again, as a countdown does', () => {
    ratio = 2
    let tick: (n: number) => void = () => undefined
    function Around() {
      const [n, setN] = useState(0)
      tick = setN
      return (
        <>
          <span>{`expires in ${n}`}</span>
          <QrCode value={LINK} />
        </>
      )
    }
    act(() => root.render(<Around />))
    const built = runCalls.count
    expect(built).toBeGreaterThan(0)
    for (const n of [1, 2, 3]) act(() => tick(n))
    expect(host.textContent).toContain('expires in 3')
    expect(runCalls.count).toBe(built)
  })
})

describe('the encoder', () => {
  it('round-trips a pairing link through the matrix alone', async () => {
    const { size, modules } = qrMatrix(LINK)
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
    const found = await (
      await zxing()
    ).readBarcodes({ data, width, height: width, colorSpace: 'srgb' }, { formats: ['QRCode'] })
    expect(found.map((item) => item.text)).toEqual([LINK])
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
