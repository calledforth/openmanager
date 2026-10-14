import { readFileSync } from 'node:fs'

/** Set by the release build (scripts/build-standalone.mjs); absent in a checkout. */
declare const __OPENMANAGER_VERSION__: string | undefined

let cached: string | undefined

/** This server's version: baked into a release, read from package.json in a checkout. */
export function serverVersion(): string {
  if (typeof __OPENMANAGER_VERSION__ === 'string') return __OPENMANAGER_VERSION__
  if (cached === undefined) {
    try {
      // src/standalone/ and dist/standalone/ both sit two levels below package.json.
      const text = readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
      const version: unknown = (JSON.parse(text) as { version?: unknown }).version
      cached = typeof version === 'string' ? version : 'unknown'
    } catch {
      cached = 'unknown'
    }
  }
  return cached
}
