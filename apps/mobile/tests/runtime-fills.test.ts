import { randomBytes } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  installAbortSignalTimeout,
  installRandomUUID,
  missingRuntimeFills,
  uuidFromRandomBytes,
  type RuntimeScope,
} from '../src/environment/runtime-fills'
import { createTimers } from './support'

// The phone's URL is `react-native-url-polyfill`'s; its only React Native
// import is `NativeModules`, for blob URLs.
vi.mock('react-native', () => ({ NativeModules: {}, Platform: { OS: 'android' } }))

/** React Native's `AbortController`: `abort()` takes no reason. */
class ReasonlessController extends AbortController {
  abort() {
    super.abort()
  }
}

function hermesLike(timers = createTimers()) {
  return {
    timers,
    scope: {
      AbortController: ReasonlessController,
      // No static `timeout`, as on React Native.
      AbortSignal: {} as typeof AbortSignal,
      setTimeout: timers.setTimeout,
    } as RuntimeScope & { URL?: typeof URL },
  }
}

describe('runtime fills', () => {
  it('adds AbortSignal.timeout where it is missing, aborting after the delay', () => {
    const { scope, timers } = hermesLike()
    expect(installAbortSignalTimeout(scope)).toBe(true)
    const signal = (scope.AbortSignal as unknown as { timeout(ms: number): AbortSignal }).timeout(
      6000,
    )
    expect(signal.aborted).toBe(false)
    timers.advance(5999)
    expect(signal.aborted).toBe(false)
    timers.advance(1)
    expect(signal.aborted).toBe(true)
  })

  it('leaves a native AbortSignal.timeout alone', () => {
    const scope = { AbortController, AbortSignal, setTimeout } as unknown as RuntimeScope
    const native = AbortSignal.timeout
    expect(installAbortSignalTimeout(scope)).toBe(false)
    expect(AbortSignal.timeout).toBe(native)
  })

  it('refuses to start without AbortController at all', () => {
    expect(() => installAbortSignalTimeout({ setTimeout } as RuntimeScope)).toThrow(
      /AbortController/,
    )
  })

  it('adds crypto.randomUUID from the given generator, with or without a crypto object', () => {
    const bare = hermesLike().scope
    expect(installRandomUUID(bare, () => 'uuid-1')).toBe(true)
    expect(bare.crypto!.randomUUID!()).toBe('uuid-1')

    const partial: RuntimeScope = { ...hermesLike().scope, crypto: {} }
    expect(installRandomUUID(partial, () => 'uuid-2')).toBe(true)
    expect(partial.crypto!.randomUUID!()).toBe('uuid-2')

    const native = { ...hermesLike().scope, crypto: { randomUUID: () => 'native' } }
    expect(installRandomUUID(native, () => 'uuid-3')).toBe(false)
    expect(native.crypto.randomUUID()).toBe('native')
  })

  it('names what is still missing, and nothing once the fills ran', async () => {
    const { scope } = hermesLike()
    // React Native's own URL throws on the accessors the endpoint helpers read.
    scope.URL = class {
      constructor() {
        throw new Error('not implemented')
      }
    } as unknown as typeof URL
    expect(missingRuntimeFills(scope)).toEqual(['URL', 'AbortSignal.timeout', 'crypto.randomUUID'])

    const { URL: PolyfillURL } = await import('react-native-url-polyfill')
    scope.URL = PolyfillURL as unknown as typeof URL
    installAbortSignalTimeout(scope)
    installRandomUUID(scope, () => 'id')
    expect(missingRuntimeFills(scope)).toEqual([])
  })
})

describe('uuidFromRandomBytes', () => {
  it('writes a version 4 UUID from 16 random bytes', () => {
    const pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    for (let i = 0; i < 50; i += 1) {
      expect(uuidFromRandomBytes(new Uint8Array(randomBytes(16)))).toMatch(pattern)
    }
    expect(uuidFromRandomBytes(new Uint8Array(16).fill(0xff))).toBe(
      'ffffffff-ffff-4fff-bfff-ffffffffffff',
    )
    expect(() => uuidFromRandomBytes(new Uint8Array(15))).toThrow()
  })

  it('fills crypto.randomUUID without calling back into it', () => {
    // On web expo-crypto's `randomUUID` is `crypto.randomUUID()`; the fill
    // must not lean on the very global it provides.
    const scope = { setTimeout } as RuntimeScope
    installRandomUUID(scope, () => uuidFromRandomBytes(new Uint8Array(randomBytes(16))))
    expect(scope.crypto!.randomUUID!()).toMatch(/^[0-9a-f-]{36}$/)
  })
})
