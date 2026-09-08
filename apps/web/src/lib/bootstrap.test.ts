import { PROTOCOL_VERSION } from '@openmanager/protocol'
import { describe, expect, it } from 'vitest'
import { bootstrapUrl, interpretBootstrapResponse } from './bootstrap'

describe('bootstrapUrl', () => {
  it('joins /bootstrap onto the stored endpoint', () => {
    expect(bootstrapUrl('http://127.0.0.1:43120')).toBe('http://127.0.0.1:43120/bootstrap')
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
    expect(
      interpretBootstrapResponse({ ok: false, status: 502, body: null }),
    ).toEqual({
      status: 'unreachable',
      message: 'The environment server responded with HTTP 502.',
    })
    expect(
      interpretBootstrapResponse({ ok: true, status: 200, body: { hello: true } }),
    ).toEqual({
      status: 'unreachable',
      message: 'The environment responded, but the bootstrap payload was not valid.',
    })
  })
})
