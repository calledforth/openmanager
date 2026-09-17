import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '../src')

const ENVIRONMENT_PATH_FILES = [
  'providers/environment-application.tsx',
  'providers/environment-client.tsx',
  'lib/environment-thread.ts',
]

describe('environment path has no driven IPC overlay', () => {
  it.each(ENVIRONMENT_PATH_FILES)(
    '%s does not use IPC overlay, stream_chunks, or session-owner driven',
    (relative) => {
      const source = readFileSync(join(srcRoot, relative), 'utf8')
      expect(source, relative).not.toMatch(/['"]stream:token['"]|['"]acp:event['"]/)
      expect(source, relative).not.toMatch(
        /['"]stream_chunks['"]|\bapi\.streamChunks\b|\bstreamChunks\./,
      )
      expect(source, relative).not.toMatch(/from ['"]convex/)
      expect(source, relative).not.toMatch(/window\.electronAPI/)
      expect(source, relative).not.toMatch(/clientId === currentClientId/)
    },
  )
})
