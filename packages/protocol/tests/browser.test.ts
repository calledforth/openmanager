import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'

it('bundles the public entry for a browser and validates without Node globals', async () => {
  const result = await build({
    stdin: {
      contents: `
        import { EnvelopeSchema } from '@openmanager/protocol'
        globalThis.valid = EnvelopeSchema.safeParse({
          type: 'response', requestId: 'req-1', payload: null,
        }).success
        globalThis.invalid = EnvelopeSchema.safeParse({ type: 'response' }).success
      `,
      resolveDir: fileURLToPath(new URL('..', import.meta.url)),
    },
    bundle: true,
    platform: 'browser',
    format: 'iife',
    write: false,
    metafile: true,
  })

  // No externals or polyfills: a Node builtin import must fail the browser build.
  expect(Object.values(result.metafile!.outputs).flatMap((output) => output.imports)).toEqual([])
  const browserGlobals: Record<string, unknown> = {}
  runInNewContext(result.outputFiles[0].text, browserGlobals)
  expect(browserGlobals.valid).toBe(true)
  expect(browserGlobals.invalid).toBe(false)
})
