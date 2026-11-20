import { Blob as NodeBlob } from 'node:buffer'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createArtifactCache, deleteArtifactCache } from './artifact-cache'

// jsdom's Blob has no arrayBuffer(); every browser's does, as Node's does.
const image = (text: string) => new NodeBlob([text], { type: 'image/png' }) as unknown as Blob

beforeEach(() => vi.stubGlobal('indexedDB', new IDBFactory()))
afterEach(() => vi.unstubAllGlobals())

describe('artifact cache', () => {
  it('keeps an image per environment and reads it back', async () => {
    const one = createArtifactCache('env-one')
    const two = createArtifactCache('env-two')
    await one.write('a', image('first'))
    const read = await one.read('a')
    expect(read?.size).toBe('first'.length)
    expect(read?.type).toBe('image/png')
    expect(await two.read('a')).toBeUndefined()
  })

  it('drops the oldest images past its budget', async () => {
    let now = 0
    const cache = createArtifactCache('env-one', { budgetBytes: 10, now: () => (now += 120_000) })
    await cache.write('old', image('12345'))
    await cache.write('mid', image('12345'))
    await cache.write('new', image('12345'))
    expect(await cache.read('old')).toBeUndefined()
    expect(await cache.read('mid')).toBeDefined()
    expect(await cache.read('new')).toBeDefined()
  })

  it('deletes everything kept when the environment is removed, and keeps nothing after', async () => {
    const cache = createArtifactCache('env-one')
    await cache.write('a', image('first'))
    await deleteArtifactCache('env-one')
    expect(await cache.read('a')).toBeUndefined()
    await cache.write('b', image('late'))
    expect(await cache.read('b')).toBeUndefined()
  })
})
