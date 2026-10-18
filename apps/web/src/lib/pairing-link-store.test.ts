import { describe, expect, it } from 'vitest'
import {
  PAIRING_LINK_STORAGE_KEY,
  forgetPairingLinks,
  madePairingLinks,
  rememberPairingLink,
  type MadePairingLink,
} from './pairing-link-store'

const NOW = Date.parse('2026-10-18T12:00:00.000Z')
const at = (ms: number) => new Date(NOW + ms).toISOString()

function memoryStorage() {
  const items = new Map<string, string>()
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  }
}

const entry = (
  linkId: string,
  expiresInMs = 60_000,
  environmentId = 'env-desk',
): MadePairingLink => ({
  environmentId,
  linkId,
  url: `https://app.example/pair#${linkId}`,
  expiresAt: at(expiresInMs),
})

describe('pairing link store', () => {
  it('keeps links by environment and link', () => {
    const storage = memoryStorage()
    rememberPairingLink(entry('a'), storage, NOW)
    rememberPairingLink(entry('b', 60_000, 'env-other'), storage, NOW)
    expect([...madePairingLinks('env-desk', storage, NOW).keys()]).toEqual(['a'])
    expect(madePairingLinks('env-other', storage, NOW).get('b')?.url).toBe(
      'https://app.example/pair#b',
    )
  })

  it('prunes links once they expire, and never keeps an expired one', () => {
    const storage = memoryStorage()
    rememberPairingLink(entry('old', 1_000), storage, NOW)
    rememberPairingLink(entry('gone', -1), storage, NOW)
    expect(madePairingLinks('env-desk', storage, NOW).has('old')).toBe(true)
    expect(madePairingLinks('env-desk', storage, NOW + 1_000).size).toBe(0)
    expect(storage.items.has(PAIRING_LINK_STORAGE_KEY)).toBe(false)
  })

  it('forgets links that stopped working, only in their environment', () => {
    const storage = memoryStorage()
    rememberPairingLink(entry('a'), storage, NOW)
    rememberPairingLink(entry('a', 60_000, 'env-other'), storage, NOW)
    forgetPairingLinks('env-desk', ['a'], storage, NOW)
    expect(madePairingLinks('env-desk', storage, NOW).size).toBe(0)
    expect(madePairingLinks('env-other', storage, NOW).size).toBe(1)
  })

  it('reads nothing from a damaged or missing store', () => {
    const storage = memoryStorage()
    storage.setItem(PAIRING_LINK_STORAGE_KEY, '{not json')
    expect(madePairingLinks('env-desk', storage, NOW).size).toBe(0)
    expect(storage.items.has(PAIRING_LINK_STORAGE_KEY)).toBe(false)
    expect(madePairingLinks('env-desk', undefined, NOW).size).toBe(0)
  })
})
