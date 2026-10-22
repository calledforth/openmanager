/**
 * The web platform pieces the shared client code calls that React Native's
 * runtime (Hermes) does not provide, each installed only when missing. Kept
 * free of React Native imports so the same functions run under Node in tests;
 * `polyfills.ts` calls them with the phone's own sources at startup.
 *
 * - `AbortSignal.timeout`: the bootstrap, route search and route health
 *   probes in `@openmanager/environment-client/connection` give up through it.
 *   React Native's `AbortController` has no static `timeout`, so without it
 *   every probe throws before its fetch starts and reads as "nothing answered".
 * - `crypto.randomUUID`: `@openmanager/app-core/logic` mints draft and session
 *   ids with it, and the WebSocket client's default request ids use it.
 *   Hermes ships no `crypto` global at all.
 *
 * The URL fill is `react-native-url-polyfill`, imported first by
 * `polyfills.ts`: React Native's own `URL` throws on `hostname`, `pathname`
 * and the other accessors the endpoint and route helpers read.
 */

type AbortSignalStatics = {
  timeout?: (ms: number) => AbortSignal
}

export type RuntimeScope = {
  AbortController?: typeof AbortController
  AbortSignal?: typeof AbortSignal
  crypto?: { randomUUID?: () => string }
  setTimeout: (fn: () => void, ms: number) => unknown
}

function timeoutReason(ms: number): Error {
  const error = new Error(`The operation timed out after ${ms} ms.`)
  error.name = 'TimeoutError'
  return error
}

/**
 * `AbortSignal.timeout(ms)`: a signal that aborts on its own after `ms`. The
 * reason is a `TimeoutError`, as the web's is; an `AbortController` whose
 * `abort` ignores its argument (React Native's) still aborts.
 */
export function installAbortSignalTimeout(scope: RuntimeScope): boolean {
  const Signal = scope.AbortSignal as (typeof AbortSignal & AbortSignalStatics) | undefined
  const Controller = scope.AbortController
  if (!Signal || !Controller) {
    throw new Error('AbortController is missing; the connection probes cannot be cancelled.')
  }
  if (typeof Signal.timeout === 'function') return false
  const setTimer = scope.setTimeout
  Object.defineProperty(Signal, 'timeout', {
    configurable: true,
    writable: true,
    value: function timeout(ms: number): AbortSignal {
      const controller = new Controller()
      setTimer(() => controller.abort(timeoutReason(ms)), ms)
      return controller.signal
    },
  })
  return true
}

/**
 * A version 4 UUID from 16 random bytes, as `crypto.randomUUID()` writes it.
 * The phone fills `crypto.randomUUID` with this over expo-crypto's random
 * bytes rather than with expo-crypto's own `randomUUID`: on web that one calls
 * `crypto.randomUUID()` itself, so where the browser has none (a page served
 * over plain http on the LAN) the fill would call itself until the stack ran
 * out. Its random bytes come from `crypto.getRandomValues` there, which every
 * browser has.
 */
export function uuidFromRandomBytes(bytes: Uint8Array): string {
  if (bytes.length < 16) throw new Error('A UUID needs 16 random bytes.')
  const b = Array.from(bytes.subarray(0, 16))
  b[6] = (b[6]! & 0x0f) | 0x40
  b[8] = (b[8]! & 0x3f) | 0x80
  const hex = b.map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** `crypto.randomUUID()` from the phone's own generator. */
export function installRandomUUID(scope: RuntimeScope, randomUUID: () => string): boolean {
  const existing = scope.crypto
  if (existing && typeof existing.randomUUID === 'function') return false
  if (existing) {
    Object.defineProperty(existing, 'randomUUID', {
      configurable: true,
      writable: true,
      value: randomUUID,
    })
  } else {
    Object.defineProperty(scope, 'crypto', {
      configurable: true,
      writable: true,
      value: { randomUUID },
    })
  }
  return true
}

/**
 * Which of the pieces the shared code needs are still missing or broken.
 * Empty once `polyfills.ts` has run; the root provider refuses to start the
 * connection otherwise, so a broken fill shows up as one clear error rather
 * than as every route reading "unreachable".
 */
export function missingRuntimeFills(scope: RuntimeScope & { URL?: typeof URL }): string[] {
  const missing: string[] = []
  try {
    const url = new scope.URL!('http://192.168.1.5:43120/base/')
    const joined = new scope.URL!('bootstrap', url.href)
    if (
      url.hostname !== '192.168.1.5' ||
      joined.href !== 'http://192.168.1.5:43120/base/bootstrap'
    ) {
      missing.push('URL')
    }
  } catch {
    missing.push('URL')
  }
  const Signal = scope.AbortSignal as (typeof AbortSignal & AbortSignalStatics) | undefined
  if (typeof Signal?.timeout !== 'function') missing.push('AbortSignal.timeout')
  if (typeof scope.crypto?.randomUUID !== 'function') missing.push('crypto.randomUUID')
  return missing
}
