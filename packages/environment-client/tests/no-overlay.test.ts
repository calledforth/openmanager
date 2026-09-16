import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '../src')

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return walk(path)
    return [path]
  })
}

describe('environment client has no driven IPC overlay', () => {
  it('does not import Electron, Convex, IPC overlay channels, or stream_chunks', () => {
    const files = walk(srcRoot).filter((path) => /\.(ts|tsx)$/.test(path) && !path.endsWith('.test.ts'))

    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      expect(source, file).not.toMatch(/window\.electronAPI/)
      expect(source, file).not.toMatch(/from ['"]convex/)
      expect(source, file).not.toMatch(/['"]stream:token['"]|['"]acp:event['"]/)
      expect(source, file).not.toMatch(/['"]stream_chunks['"]|\bapi\.streamChunks\b|\bstreamChunks\./)
    }
  })
})
