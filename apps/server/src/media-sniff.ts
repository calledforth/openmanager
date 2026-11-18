import type { ShareableType } from './upload-limits.ts'

/** How many leading bytes `sniffMedia` reads. */
export const SNIFF_BYTES = 16

const ascii = (bytes: Uint8Array, start: number, end: number) =>
  String.fromCharCode(...bytes.subarray(start, end))

/**
 * What a shared file is, by its leading bytes rather than its name: a file is
 * shared only as what it actually holds, so a renamed key file is refused
 * and a `.mp4` that is really a QuickTime movie is labelled as one.
 */
export function sniffMedia(head: Uint8Array): ShareableType | undefined {
  if (head.length < 12) return undefined
  if (
    head[0] === 0x89 &&
    ascii(head, 1, 4) === 'PNG' &&
    head[4] === 0x0d &&
    head[5] === 0x0a &&
    head[6] === 0x1a &&
    head[7] === 0x0a
  ) {
    return 'image/png'
  }
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg'
  if (ascii(head, 0, 6) === 'GIF87a' || ascii(head, 0, 6) === 'GIF89a') return 'image/gif'
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 12) === 'WEBP') return 'image/webp'
  // EBML: WebM, and Matroska, which browsers play as the same container.
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
    return 'video/webm'
  }
  // ISO base media: the `ftyp` box names the brand. QuickTime's own is `qt  `;
  // an older movie opens with another top-level atom instead.
  const box = ascii(head, 4, 8)
  if (box === 'ftyp') return ascii(head, 8, 12) === 'qt  ' ? 'video/quicktime' : 'video/mp4'
  if (box === 'moov' || box === 'mdat' || box === 'wide' || box === 'free') {
    return 'video/quicktime'
  }
  return undefined
}

/** The extension a stored file of this type is named with. */
export const extensionOf = (mimeType: ShareableType) =>
  ({
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov',
  })[mimeType]
