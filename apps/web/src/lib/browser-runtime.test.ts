import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { hasElectronBridge, isBrowserOnline, subscribeToNetworkStatus } from './browser-runtime'

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return walk(path)
    return [path]
  })
}

describe('browser runtime', () => {
  it('is false for a plain window and true when electronAPI exists', () => {
    expect(hasElectronBridge({})).toBe(false)
    expect(hasElectronBridge(window)).toBe(false)
    expect('electronAPI' in window).toBe(false)
    expect(hasElectronBridge({ electronAPI: {} })).toBe(true)
  })

  it('treats only an explicit navigator.onLine false as offline', () => {
    expect(isBrowserOnline({ navigator: { onLine: false } })).toBe(false)
    expect(isBrowserOnline({ navigator: { onLine: true } })).toBe(true)
    expect(isBrowserOnline({ navigator: {} })).toBe(true)
    expect(isBrowserOnline({})).toBe(true)
  })

  it('listens to both network transitions and unsubscribes from both', () => {
    const added: string[] = []
    const removed: string[] = []
    const target = {
      addEventListener: (type: string) => added.push(type),
      removeEventListener: (type: string) => removed.push(type),
    }
    const unsubscribe = subscribeToNetworkStatus(() => undefined, target)
    expect(added).toEqual(['online', 'offline'])
    unsubscribe()
    expect(removed).toEqual(['online', 'offline'])
  })

  it('notifies the listener on every transition', () => {
    const listeners: Array<() => void> = []
    const target = {
      navigator: { onLine: true },
      addEventListener: (_type: string, listener: () => void) => listeners.push(listener),
      removeEventListener: () => undefined,
    }
    let notified = 0
    subscribeToNetworkStatus(() => (notified += 1), target)
    for (const listener of listeners) listener()
    expect(notified).toBe(2)
  })

    it('does not import Electron, Convex, IPC overlay channels, or stream_chunks', () => {
    const files = walk(srcRoot).filter(
      (path) =>
        /\.(ts|tsx)$/.test(path) &&
        !path.endsWith('.test.ts') &&
        !path.endsWith('.test.tsx') &&
        !path.endsWith('test-utils.tsx') &&
        !path.endsWith('test-setup.ts') &&
        !path.endsWith('routeTree.gen.ts'),
    )

    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      expect(source, file).not.toMatch(/window\.electronAPI/)
      expect(source, file).not.toMatch(/from ['"]convex/)
      expect(source, file).not.toMatch(/CONVEX_URL/)
      expect(source, file).not.toMatch(/VITE_CONVEX/)
      expect(source, file).not.toMatch(/['"]stream:token['"]|['"]acp:event['"]/)
      expect(source, file).not.toMatch(/['"]stream_chunks['"]|\bapi\.streamChunks\b|\bstreamChunks\./)
    }
  })
})
