/**
 * Pictures for the dev fixture's image threads, drawn here rather than
 * shipped: a small PNG each (a hue, a lighter disc, a dark band, so ten of
 * them tell apart), encoded with stored deflate blocks so no zlib is needed
 * on the phone or in a test. Only for the fixture; nothing here reaches a
 * server.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function adler32(bytes: Uint8Array): number {
  let a = 1
  let b = 0
  for (const byte of bytes) {
    a = (a + byte) % 65521
    b = (b + a) % 65521
  }
  return ((b << 16) | a) >>> 0
}

function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]
}

function chunk(type: string, data: Uint8Array): number[] {
  const typed = new Uint8Array(4 + data.length)
  typed.set([...type].map((ch) => ch.charCodeAt(0)))
  typed.set(data, 4)
  return [...u32(data.length), ...typed, ...u32(crc32(typed))]
}

/** A zlib stream of stored blocks: no compression, every byte as it is. */
function storedZlib(raw: Uint8Array): Uint8Array {
  const blocks: number[] = [0x78, 0x01]
  const MAX = 65535
  for (let at = 0; at < raw.length || at === 0; at += MAX) {
    const len = Math.min(MAX, raw.length - at)
    const final = at + len >= raw.length ? 1 : 0
    blocks.push(final, len & 0xff, len >>> 8, ~len & 0xff, (~len >>> 8) & 0xff)
    for (let i = 0; i < len; i += 1) blocks.push(raw[at + i]!)
    if (raw.length === 0) break
  }
  blocks.push(...u32(adler32(raw)))
  return Uint8Array.from(blocks)
}

function hsl(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)]
}

function base64(bytes: Uint8Array): string {
  let binary = ''
  for (let at = 0; at < bytes.length; at += 8192) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 8192))
  }
  return btoa(binary)
}

/** A `width`×`height` PNG as base64: hue `hue`, its disc and band placed by `seed`. */
export function fixturePng(width: number, height: number, hue: number, seed: number): string {
  const raw = new Uint8Array(height * (1 + width * 3))
  const top = hsl(hue, 0.5, 0.32)
  const bottom = hsl((hue + 28) % 360, 0.6, 0.58)
  const disc = hsl((hue + 12) % 360, 0.7, 0.8)
  const cx = width * (0.3 + (0.4 * ((seed * 7) % 5)) / 4)
  const cy = height * (0.3 + (0.4 * ((seed * 3) % 5)) / 4)
  const radius = Math.min(width, height) * 0.22
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 3)
    raw[row] = 0
    const t = y / Math.max(1, height - 1)
    for (let x = 0; x < width; x += 1) {
      let r = top[0] + (bottom[0] - top[0]) * t
      let g = top[1] + (bottom[1] - top[1]) * t
      let b = top[2] + (bottom[2] - top[2]) * t
      // A dark band across, at a slant that changes with the seed.
      const band = (x + y * (0.4 + (seed % 3) * 0.3) - width * 0.6) % (width * 0.5)
      if (band >= 0 && band < 14) {
        r *= 0.55
        g *= 0.55
        b *= 0.55
      }
      const dx = x - cx
      const dy = y - cy
      if (dx * dx + dy * dy < radius * radius) [r, g, b] = disc
      const at = row + 1 + x * 3
      raw[at] = r
      raw[at + 1] = g
      raw[at + 2] = b
    }
  }
  const header = Uint8Array.from([...u32(width), ...u32(height), 8, 2, 0, 0, 0])
  const png = Uint8Array.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...chunk('IHDR', header),
    ...chunk('IDAT', storedZlib(raw)),
    ...chunk('IEND', new Uint8Array(0)),
  ])
  return base64(png)
}
