import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { ContentBlock } from '@agentpack/contract'
import type { v2 } from '@openmanager/codex-app-server-protocol'

/**
 * The images Codex makes and looks at, as image content for their tool call.
 *
 * Codex says where an image is rather than handing it over: a generated image
 * is saved to a file under the Codex home (`savedPath`) that does not last,
 * and `imageView` names the file the model looked at. Each is read here, once
 * and at once, as the item reports it, and goes out as the call's image
 * content. The environment then stores it as the session's own artifact and
 * files it in the reply under the call's id, as it does any tool's image
 * (CAL-199), so the chat keeps it after the file is gone.
 *
 * What is read, and what is refused (with a reason the row shows):
 * - only an absolute path to a regular file, opened without blocking, so a
 *   path that names a FIFO or a device cannot hang the runtime;
 * - at most `MAX_CODEX_IMAGE_BYTES`, the most the environment keeps of an
 *   image a tool returns (its `MAX_ATTACHMENT_BYTES`);
 * - only PNG, JPEG or WebP, known by the file's leading bytes, never its
 *   name: the types the environment stores for a tool, and nothing active
 *   (SVG), so a renamed key file is refused, not shown.
 */

/** The most an image may hold: the environment's ceiling for an image a tool
 * returns (`MAX_ATTACHMENT_BYTES` in `apps/server/src/upload-limits.ts`). */
export const MAX_CODEX_IMAGE_BYTES = 25 * 1024 * 1024

export type ImageRead = { image: ContentBlock & { type: 'image' } } | { error: string }

/** The image in the file at `path`, or why it cannot be shown. */
export function readImageFile(path: string, maxBytes = MAX_CODEX_IMAGE_BYTES): ImageRead {
  if (!path) return { error: 'Codex named no file for the image.' }
  if (!isAbsolute(path)) return { error: `${path} is not an absolute path, so it was not read.` }
  let fd: number
  try {
    // O_NONBLOCK: opening a FIFO for reading would otherwise wait for a writer.
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { error: `There is no file at ${path} any more.` }
    if (code === 'EACCES' || code === 'EPERM') return { error: `${path} could not be read: permission denied.` }
    if (code === 'EISDIR') return { error: `${path} is not a file.` }
    return { error: `${path} could not be read (${code ?? 'unknown error'}).` }
  }
  try {
    // Checked on what was opened, so a file swapped after a look is judged as read.
    const stat = fstatSync(fd)
    if (!stat.isFile()) return { error: `${path} is not a file.` }
    if (stat.size === 0) return { error: `${path} is empty.` }
    if (stat.size > maxBytes) return { error: tooLarge(path, maxBytes) }
    // One byte past the ceiling, so a file that grew since is caught.
    const bytes = Buffer.alloc(Math.min(stat.size, maxBytes) + 1)
    let length = 0
    while (length < bytes.length) {
      const read = readSync(fd, bytes, length, bytes.length - length, length)
      if (read === 0) break
      length += read
    }
    if (length > maxBytes) return { error: tooLarge(path, maxBytes) }
    return imageOf(bytes.subarray(0, length), path)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return { error: `${path} could not be read (${code ?? 'unknown error'}).` }
  } finally {
    closeSync(fd)
  }
}

/** The image in base64 `data` (a generated image's `result`), or why not. */
export function decodeImage(data: string, what: string, maxBytes = MAX_CODEX_IMAGE_BYTES): ImageRead {
  if (data.length > 4 * Math.ceil(maxBytes / 3)) return { error: tooLarge(what, maxBytes) }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length % 4 !== 0) return { error: `${what} is not base64.` }
  const bytes = Buffer.from(data, 'base64')
  if (bytes.length === 0) return { error: `${what} is empty.` }
  if (bytes.length > maxBytes) return { error: tooLarge(what, maxBytes) }
  return imageOf(bytes, what)
}

/**
 * The image Codex generated. The file it saved comes first: it is the image
 * Codex kept, and it lasts only so long. When that file is already gone, the
 * item's own `result` (base64 of the same image, _probed_ on 0.170) stands
 * in for it. Only when both fail is the image lost, and the reason is the
 * file's: that is where the image was meant to be.
 */
export function generatedImage(item: Extract<v2.ThreadItem, { type: 'imageGeneration' }>): ImageRead {
  const result = 'result' in item && typeof item.result === 'string' ? item.result : ''
  if (item.savedPath) {
    const saved = readImageFile(item.savedPath)
    if ('image' in saved || !result) return saved
    const inline = decodeImage(result, 'The generated image')
    return 'image' in inline ? inline : saved
  }
  if (result) return decodeImage(result, 'The generated image')
  return { error: 'Codex did not save the image it generated.' }
}

/** Why a generation Codex reports as not completed ended, as the row says it. */
export function generationFailure(item: Extract<v2.ThreadItem, { type: 'imageGeneration' }>): string {
  const failure = item.failure
  if (failure?.type === 'usageLimitExceeded') {
    // `resetsAt` is in epoch seconds, as every Codex reset time is.
    const resets =
      typeof failure.resetsAt === 'number'
        ? ` It resets at ${new Date(failure.resetsAt * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC.`
        : ''
    return `The image generation limit was reached.${resets}`
  }
  if (failure) return `Image generation failed (${String((failure as { type?: unknown }).type ?? 'unknown')}).`
  return `Image generation ended ${item.status ? `as ${item.status}` : 'without an image'}.`
}

function tooLarge(what: string, maxBytes: number): string {
  return `${what} is larger than ${Math.round(maxBytes / 1024 / 1024)} MB, the most an image shown in the chat may be.`
}

/** The bytes as an image of a type the chat shows, by their leading bytes. */
function imageOf(bytes: Buffer, what: string): ImageRead {
  const mimeType = sniffImage(bytes)
  if (!mimeType) {
    const gif = bytes.subarray(0, 6).toString('latin1')
    return {
      error:
        gif === 'GIF87a' || gif === 'GIF89a'
          ? `${what} is a GIF; the chat shows PNG, JPEG and WebP images.`
          : `${what} is not a PNG, JPEG or WebP image.`,
    }
  }
  return { image: { type: 'image', mimeType, data: bytes.toString('base64') } }
}

/** PNG, JPEG or WebP, by the leading bytes (as the environment's `sniffMedia`). */
export function sniffImage(bytes: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' | undefined {
  if (bytes.length < 12) return undefined
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end))
  if (bytes[0] === 0x89 && ascii(1, 4) === 'PNG' && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a)
    return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp'
  return undefined
}
