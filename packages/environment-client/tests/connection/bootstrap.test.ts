import { PROTOCOL_VERSION } from '@openmanager/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  bootstrapUrl,
  fetchBootstrap,
  interpretBootstrapResponse,
  noLoopbackGate,
} from '../../src/connection/bootstrap'

/** For the cases that are not about the loopback check. */
const NO_GATE = { loopbackAccessDenied: noLoopbackGate }

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchBootstrap', () => {
  it('tells an answer the page may not read from silence', async () => {
    // A gateway's error page without CORS headers: the readable request
    // fails like silence, but a no-cors one gets an opaque answer.
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.mode === 'no-cors') return { type: 'opaque' } as Response
      throw new TypeError('Failed to fetch')
    })
    vi.stubGlobal('fetch', fetch)
    expect(await fetchBootstrap('https://tunnel.example', NO_GATE)).toMatchObject({
      status: 'unreachable',
      cause: 'opaque',
    })
    expect(fetch.mock.calls.map(([, init]) => init?.mode)).toEqual([undefined, 'no-cors'])
    expect(fetch.mock.calls[1]![1]).toMatchObject({ redirect: 'manual' })

    // A sign-in gate redirects; unfollowed, that reads as an opaque redirect.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.mode === 'no-cors') return { type: 'opaqueredirect' } as Response
        throw new TypeError('Failed to fetch')
      }),
    )
    expect(await fetchBootstrap('https://tunnel.example', NO_GATE)).toMatchObject({
      cause: 'opaque_redirect',
    })

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    expect(await fetchBootstrap('https://tunnel.example', NO_GATE)).toMatchObject({
      cause: 'network',
    })
  })

  it('still asks where AbortSignal.any is missing', async () => {
    const RealAbortSignal = AbortSignal
    vi.stubGlobal('AbortSignal', {
      timeout: (ms: number) => RealAbortSignal.timeout(ms),
    })
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.mode === 'no-cors') return { type: 'opaque' } as Response
      throw new TypeError('Failed to fetch')
    })
    vi.stubGlobal('fetch', fetch)
    const controller = new AbortController()
    expect(
      await fetchBootstrap('https://tunnel.example', { signal: controller.signal, ...NO_GATE }),
    ).toMatchObject({ cause: 'opaque' })
    expect(fetch.mock.calls[1]![1]!.signal).toBeInstanceOf(RealAbortSignal)
  })

  it('does not ask again once the fetch was cancelled', async () => {
    const fetch = vi.fn(async () => {
      throw new DOMException('Timed out', 'TimeoutError')
    })
    vi.stubGlobal('fetch', fetch)
    const controller = new AbortController()
    controller.abort()
    expect(
      await fetchBootstrap('https://tunnel.example', { signal: controller.signal, ...NO_GATE }),
    ).toMatchObject({ cause: 'network' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe('bootstrapUrl', () => {
  it('joins bootstrap onto the stored endpoint, including a path prefix', () => {
    expect(bootstrapUrl('http://127.0.0.1:43120')).toBe('http://127.0.0.1:43120/bootstrap')
    expect(bootstrapUrl('https://host.example/openmanager')).toBe(
      'https://host.example/openmanager/bootstrap',
    )
  })
})

describe('interpretBootstrapResponse', () => {
  it('returns ready from a compatible bootstrap body', () => {
    expect(
      interpretBootstrapResponse({
        ok: true,
        status: 200,
        body: {
          protocolVersion: PROTOCOL_VERSION,
          environmentId: 'env-local',
          capabilities: ['connection.heartbeat'],
          label: 'Local environment',
        },
      }),
    ).toEqual({
      status: 'ready',
      environmentId: 'env-local',
      label: 'Local environment',
      protocolVersion: PROTOCOL_VERSION,
    })
  })

  it('returns incompatible_protocol from evaluateBootstrap', () => {
    const result = interpretBootstrapResponse({
      ok: true,
      status: 200,
      body: {
        protocolVersion: PROTOCOL_VERSION + 1,
        environmentId: 'env-local',
        capabilities: [],
        label: 'Local environment',
      },
    })
    expect(result).toMatchObject({
      status: 'incompatible_protocol',
      clientProtocolVersion: PROTOCOL_VERSION,
      serverProtocolVersion: PROTOCOL_VERSION + 1,
      environmentId: 'env-local',
      label: 'Local environment',
    })
  })

  it('maps auth HTTP statuses and auth envelopes to unauthorized', () => {
    expect(
      interpretBootstrapResponse({
        ok: false,
        status: 403,
        body: { error: { code: 'auth', message: 'Origin is not allowed.' } },
      }),
    ).toEqual({ status: 'unauthorized', message: 'Origin is not allowed.' })

    expect(
      interpretBootstrapResponse({
        ok: false,
        status: 401,
        body: null,
      }),
    ).toMatchObject({ status: 'unauthorized' })
  })

  it('maps other failures and invalid payloads to unreachable', () => {
    expect(interpretBootstrapResponse({ ok: false, status: 502, body: null })).toEqual({
      status: 'unreachable',
      message: 'The environment server responded with HTTP 502.',
      cause: 'http',
      httpStatus: 502,
    })
    expect(interpretBootstrapResponse({ ok: true, status: 200, body: { hello: true } })).toEqual({
      status: 'unreachable',
      message: 'The environment responded, but the bootstrap payload was not valid.',
      cause: 'invalid',
    })
  })
})

describe('fetchBootstrap', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function failFetch() {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
  }

  it('tells a host that blocked this device apart from nothing listening', async () => {
    failFetch()
    const loopbackAccessDenied = vi.fn(async () => true)
    await expect(
      fetchBootstrap('http://127.0.0.1:43120', { loopbackAccessDenied }),
    ).resolves.toEqual({
      status: 'unreachable',
      message:
        'This browser blocked this page from reaching http://127.0.0.1:43120 on this device.',
      cause: 'blocked',
    })
  })

  it('keeps a failure as a network failure when access was not refused', async () => {
    failFetch()
    await expect(
      fetchBootstrap('http://127.0.0.1:43120', { loopbackAccessDenied: async () => false }),
    ).resolves.toMatchObject({ status: 'unreachable', cause: 'network' })
  })

  it('reads a loopback failure as a network failure for a host with no loopback gate', async () => {
    failFetch()
    await expect(fetchBootstrap('http://127.0.0.1:43120', NO_GATE)).resolves.toMatchObject({
      status: 'unreachable',
      cause: 'network',
    })
  })

  it('never asks the loopback check about a remote route', async () => {
    failFetch()
    const loopbackAccessDenied = vi.fn(async () => true)
    await expect(
      fetchBootstrap('https://env.example.com', { loopbackAccessDenied }),
    ).resolves.toMatchObject({ status: 'unreachable', cause: 'network' })
    expect(loopbackAccessDenied).not.toHaveBeenCalled()
  })
})
