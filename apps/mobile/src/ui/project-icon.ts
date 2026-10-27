const SVG_PREFIX = 'data:image/svg+xml'
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Base64 to bytes, without the runtime's `atob` (not every engine has one). */
function base64Bytes(input: string): Uint8Array | null {
  const clean = input.replace(/[\s=]+/g, '')
  const bytes = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let buffer = 0
  let bits = 0
  let at = 0
  for (const char of clean) {
    const value = ALPHABET.indexOf(char)
    if (value === -1) return null
    buffer = (buffer << 6) | value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes[at++] = (buffer >> bits) & 0xff
    }
  }
  return bytes.subarray(0, at)
}

/** UTF-8 bytes to text; a malformed sequence reads as U+FFFD rather than failing. */
function utf8(bytes: Uint8Array): string {
  if (typeof TextDecoder !== 'undefined') return new TextDecoder().decode(bytes)
  let text = ''
  for (const byte of bytes) text += String.fromCharCode(byte)
  return text
}

/**
 * A declared icon's SVG source, for `SvgXml`: React Native's `Image` draws
 * bitmaps only. Undefined when the data URL is not an SVG; null when it is
 * one that cannot be read. The environment sends base64 (`workspace.icon`);
 * a percent-encoded one is read too.
 */
export function svgOfDataUrl(src: string): string | null | undefined {
  if (!src.startsWith(SVG_PREFIX)) return undefined
  const comma = src.indexOf(',')
  if (comma === -1) return null
  const meta = src.slice(SVG_PREFIX.length, comma)
  const body = src.slice(comma + 1)
  if (meta.split(';').includes('base64')) {
    const bytes = base64Bytes(body)
    return bytes ? utf8(bytes) : null
  }
  try {
    return decodeURIComponent(body)
  } catch {
    return null
  }
}
