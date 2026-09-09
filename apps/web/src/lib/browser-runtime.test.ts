import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { hasElectronBridge } from './browser-runtime'

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

  it('does not import Electron, Convex, or a Convex URL', () => {
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
      expect(source, file).not.toMatch(/from ['"]electron(?:\/|$|')/)
      expect(source, file).not.toMatch(/from ['"]node:/)
      expect(source, file).not.toMatch(/from ['"](?:fs|path|os|child_process|electron-store)['"]/)
    }
  })
})
