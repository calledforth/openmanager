import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  BootstrapResponseSchema,
  CapabilityListSchema,
  ERROR_RETRY_POLICY,
  PROTOCOL_VERSION,
  ProtocolHandshakeCommandSchema,
  ProtocolHandshakeResultSchema,
  ServerMessageSchema,
  evaluateBootstrap,
  negotiateProtocolHandshake,
  parseProtocolHandshakeResult,
  type BootstrapResponse,
  type BootstrapState,
  type ProtocolHandshakeCommand,
  type ProtocolHandshakeResult,
} from '@openmanager/protocol'

const bootstrap = {
  protocolVersion: PROTOCOL_VERSION,
  environmentId: 'env-1',
  capabilities: ['session.read', 'turn.send'],
  websocketUrl: 'ws://127.0.0.1:3000/ws',
}

const handshake = {
  type: 'command',
  requestId: 'handshake-1',
  name: 'protocol.handshake',
  payload: {
    protocolVersion: PROTOCOL_VERSION,
    requiredCapabilities: ['session.read'],
  },
} satisfies ProtocolHandshakeCommand

describe('HTTP bootstrap negotiation', () => {
  it('round-trips required fields and preserves additive connection metadata', () => {
    const parsed = BootstrapResponseSchema.parse(JSON.parse(JSON.stringify(bootstrap)))
    expect(parsed).toEqual(bootstrap)
    expectTypeOf(parsed).toEqualTypeOf<BootstrapResponse>()
  })

  it.each([
    { protocolVersion: 0 },
    { protocolVersion: 1.5 },
    { protocolVersion: Number.MAX_SAFE_INTEGER + 1 },
    { environmentId: '' },
    { capabilities: ['session.read', 'session.read'] },
    { capabilities: ['Session.read'] },
    { future: () => undefined },
  ])('rejects an invalid bootstrap field: %j', (change) => {
    expect(BootstrapResponseSchema.safeParse({ ...bootstrap, ...change }).success).toBe(false)
  })

  it('derives a ready state and reports every missing required capability', () => {
    expect(
      evaluateBootstrap(bootstrap, {
        requiredCapabilities: ['turn.send', 'session.read'],
      }),
    ).toEqual({ state: 'ready', bootstrap })

    const state = evaluateBootstrap(bootstrap, {
      requiredCapabilities: ['terminal.open', 'session.read', 'git.status'],
    })
    expect(state).toEqual({
      state: 'capability_missing',
      bootstrap,
      missingCapabilities: ['terminal.open', 'git.status'],
    })
    expectTypeOf(state).toEqualTypeOf<BootstrapState>()
  })

  it.each([
    { client: 2, server: 1 },
    { client: 1, server: 2 },
  ])('makes older/newer version mismatch renderable: %j', ({ client, server }) => {
    expect(
      evaluateBootstrap(
        { ...bootstrap, protocolVersion: server },
        { protocolVersion: client },
      ),
    ).toEqual({
      state: 'incompatible_protocol',
      bootstrap: { ...bootstrap, protocolVersion: server },
      clientProtocolVersion: client,
      serverProtocolVersion: server,
    })
  })

  it('validates required capabilities as protocol names without rejecting unknown advertisements', () => {
    expect(evaluateBootstrap({ ...bootstrap, capabilities: ['future.feature'] }).state).toBe('ready')
    expect(() => evaluateBootstrap(bootstrap, { requiredCapabilities: ['Future.feature'] })).toThrow()
    expect(CapabilityListSchema.safeParse(['turn.send', 'turn.send']).success).toBe(false)
  })
})

describe('WebSocket application handshake', () => {
  it('accepts a compatible handshake with a correlated bootstrap response', () => {
    expect(ProtocolHandshakeCommandSchema.parse(handshake)).toEqual(handshake)
    const result = negotiateProtocolHandshake(handshake, bootstrap)
    expect(result).toEqual({
      type: 'response',
      requestId: handshake.requestId,
      payload: bootstrap,
    })
    expect(parseProtocolHandshakeResult(handshake, result)).toEqual(result)
    expectTypeOf(result).toEqualTypeOf<ProtocolHandshakeResult>()
  })

  it.each([
    { client: 2, server: 1 },
    { client: 1, server: 2 },
  ])('rejects older/newer version mismatch with structured versions: %j', ({ client, server }) => {
    const command = {
      ...handshake,
      payload: { ...handshake.payload, protocolVersion: client },
    }
    const result = negotiateProtocolHandshake(command, { ...bootstrap, protocolVersion: server })
    expect(result).toEqual({
      type: 'error',
      requestId: handshake.requestId,
      error: {
        code: 'protocol_incompatible',
        message: `Client protocol version ${client} is incompatible with server protocol version ${server}`,
        details: { clientProtocolVersion: client, serverProtocolVersion: server },
      },
    })
    const genericEnvelope = ServerMessageSchema.parse(JSON.parse(JSON.stringify(result)))
    expect(parseProtocolHandshakeResult(command, genericEnvelope)).toEqual(result)
    expect(ERROR_RETRY_POLICY.protocol_incompatible).toBe('after_upgrade')
  })

  it('detects another version before validating its version-specific payload', () => {
    expect(
      negotiateProtocolHandshake(
        {
          type: 'command',
          requestId: handshake.requestId,
          name: 'protocol.handshake',
          payload: { protocolVersion: 2, futureClientField: true },
        },
        bootstrap,
      ),
    ).toMatchObject({
      type: 'error',
      requestId: handshake.requestId,
      error: {
        code: 'protocol_incompatible',
        details: { clientProtocolVersion: 2, serverProtocolVersion: PROTOCOL_VERSION },
      },
    })
  })

  it('rejects missing required capabilities with a structured list', () => {
    const command = {
      ...handshake,
      payload: {
        ...handshake.payload,
        requiredCapabilities: ['session.read', 'terminal.open', 'git.status'],
      },
    }
    expect(negotiateProtocolHandshake(command, bootstrap)).toMatchObject({
      type: 'error',
      requestId: handshake.requestId,
      error: {
        code: 'capability_missing',
        details: { missingCapabilities: ['terminal.open', 'git.status'] },
      },
    })
  })

  it('returns a bounded error for the maximum valid capability list', () => {
    const requiredCapabilities = Array.from(
      { length: 256 },
      (_, index) => `feature.${index.toString().padStart(3, '0')}.${'x'.repeat(115)}`,
    )
    const result = negotiateProtocolHandshake(
      { ...handshake, payload: { ...handshake.payload, requiredCapabilities } },
      { ...bootstrap, capabilities: [] },
    )
    expect(result).toMatchObject({
      type: 'error',
      error: {
        code: 'capability_missing',
        message: 'Environment is missing one or more required capabilities',
        details: { missingCapabilities: requiredCapabilities },
      },
    })
  })

  it('rejects uncorrelated, contradictory, and incomplete handshake results', () => {
    const accepted = negotiateProtocolHandshake(handshake, bootstrap)
    expect(() =>
      parseProtocolHandshakeResult(handshake, { ...accepted, requestId: 'another-request' }),
    ).toThrow('pending request ID')
    expect(() =>
      parseProtocolHandshakeResult(handshake, {
        ...accepted,
        payload: { ...bootstrap, protocolVersion: 2 },
      }),
    ).toThrow('accepted an incompatible')
    expect(() =>
      parseProtocolHandshakeResult(handshake, {
        ...accepted,
        payload: { ...bootstrap, capabilities: [] },
      }),
    ).toThrow('without required capabilities')
    expect(() =>
      parseProtocolHandshakeResult(handshake, {
        type: 'error',
        requestId: handshake.requestId,
        error: {
          code: 'capability_missing',
          message: 'Missing capability',
          details: { missingCapabilities: ['terminal.open'] },
        },
      }),
    ).toThrow('unrequested capability')
    const newerClient = {
      ...handshake,
      payload: { ...handshake.payload, protocolVersion: 2 },
    }
    const incompatible = negotiateProtocolHandshake(newerClient, bootstrap)
    if (incompatible.type !== 'error' || incompatible.error.code !== 'protocol_incompatible') {
      throw new Error('Expected an incompatible protocol result')
    }
    for (const details of [
      { ...incompatible.error.details, clientProtocolVersion: 3 },
      { ...incompatible.error.details, serverProtocolVersion: 2 },
    ]) {
      expect(() =>
        parseProtocolHandshakeResult(newerClient, {
          ...incompatible,
          error: { ...incompatible.error, details },
        }),
      ).toThrow('contradicts the requested protocol version')
    }
    expect(
      ProtocolHandshakeResultSchema.safeParse({
        type: 'error',
        requestId: handshake.requestId,
        error: { code: 'protocol_incompatible', message: 'Upgrade required' },
      }).success,
    ).toBe(false)
  })
})
