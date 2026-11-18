import { describe, expect, it } from 'vitest'
import { createMediaGrants, MEDIA_GRANTS_PER_CLIENT, parseRange } from '../src/media-stream.js'
import { sniffMedia } from '../src/media-sniff.js'

const bytes = (...parts: (string | number[])[]) =>
  Uint8Array.from(
    parts.flatMap((part) => (typeof part === 'string' ? [...Buffer.from(part, 'latin1')] : part)),
  )

describe('parseRange', () => {
  it('reads the one range a player asks for', () => {
    expect(parseRange(undefined, 100)).toBeUndefined()
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 })
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 })
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 })
    expect(parseRange('bytes=-1000', 100)).toEqual({ start: 0, end: 99 })
    // An end past the file is clipped to it, as Safari's probes expect.
    expect(parseRange('bytes=50-5000', 100)).toEqual({ start: 50, end: 99 })
  })

  it('answers several ranges or another unit whole, and refuses what is past the end', () => {
    expect(parseRange('bytes=0-1,5-6', 100)).toBeUndefined()
    expect(parseRange('items=0-1', 100)).toBeUndefined()
    expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable')
    expect(parseRange('bytes=9-3', 100)).toBe('unsatisfiable')
    expect(parseRange('bytes=-0', 100)).toBe('unsatisfiable')
  })
})

describe('media grants', () => {
  it('answer until they expire', () => {
    let now = 1_000
    const grants = createMediaGrants({ clock: () => now, ttlMs: 500 })
    const { token, expiresAt } = grants.mint({ clientId: 'c', sessionId: 's', artifactId: 'a' })
    expect(expiresAt).toBe(1_500)
    expect(grants.lookup(token)).toMatchObject({ clientId: 'c', sessionId: 's', artifactId: 'a' })
    expect(grants.lookup('guessed')).toBeUndefined()
    now = 1_500
    expect(grants.lookup(token)).toBeUndefined()
  })

  it('end with the client they were minted for', () => {
    const grants = createMediaGrants()
    const mine = grants.mint({ clientId: 'c', sessionId: 's', artifactId: 'a' })
    const theirs = grants.mint({ clientId: 'd', sessionId: 's', artifactId: 'a' })
    grants.revokeClient('c')
    expect(grants.lookup(mine.token)).toBeUndefined()
    expect(grants.lookup(theirs.token)).toBeDefined()
  })

  it('keep only the newest few a client holds', () => {
    const grants = createMediaGrants()
    const first = grants.mint({ clientId: 'c', sessionId: 's', artifactId: 'a' })
    for (let index = 0; index < MEDIA_GRANTS_PER_CLIENT; index += 1) {
      grants.mint({ clientId: 'c', sessionId: 's', artifactId: 'a' })
    }
    expect(grants.lookup(first.token)).toBeUndefined()
    expect(grants.size).toBe(MEDIA_GRANTS_PER_CLIENT)
  })
})

describe('sniffMedia', () => {
  it('names media by its bytes', () => {
    expect(sniffMedia(bytes([0, 0, 0, 0x18], 'ftypisom', [0, 0, 0, 0]))).toBe('video/mp4')
    expect(sniffMedia(bytes([0, 0, 0, 0x14], 'ftypqt  ', [0, 0, 0, 0]))).toBe('video/quicktime')
    expect(sniffMedia(bytes([0x1a, 0x45, 0xdf, 0xa3], 'xxxxxxxxxxxx'))).toBe('video/webm')
    expect(sniffMedia(bytes([0x89], 'PNG', [0x0d, 0x0a, 0x1a, 0x0a], 'xxxx'))).toBe('image/png')
    expect(sniffMedia(bytes([0xff, 0xd8, 0xff], 'xxxxxxxxxxxxx'))).toBe('image/jpeg')
    expect(sniffMedia(bytes('GIF89a', 'xxxxxxxxxx'))).toBe('image/gif')
    expect(sniffMedia(bytes('RIFF', [1, 2, 3, 4], 'WEBPVP8 '))).toBe('image/webp')
  })

  it('refuses what shares the MP4 container but is not video', () => {
    for (const brand of ['heic', 'avif', 'mif1', 'M4A ', 'jp2 ']) {
      expect(sniffMedia(bytes([0, 0, 0, 0x18], `ftyp${brand}`, [0, 0, 0, 0]))).toBeUndefined()
    }
    // A pre-`ftyp` movie passes; a file that merely has `free` there does not.
    expect(sniffMedia(bytes([0, 0, 0, 8], 'moov', 'xxxxxxxx'))).toBe('video/quicktime')
    expect(sniffMedia(bytes([0, 0, 0, 8], 'wide', [0, 0, 0, 8], 'mdat'))).toBe('video/quicktime')
    expect(sniffMedia(bytes([0, 0, 0, 8], 'free', 'xxxxxxxx'))).toBeUndefined()
    expect(sniffMedia(bytes([0, 0, 0, 8], 'mdat', 'xxxxxxxx'))).toBeUndefined()
  })

  it('refuses anything else, whatever it is named', () => {
    expect(sniffMedia(bytes('-----BEGIN OPENSSH PRIVATE KEY-----'))).toBeUndefined()
    expect(sniffMedia(bytes('<svg xmlns="http://www.w3.org/2000/svg">'))).toBeUndefined()
    expect(sniffMedia(bytes('short'))).toBeUndefined()
  })
})
