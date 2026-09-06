import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  CommandEnvelopeSchema,
  ResponseEnvelopeSchema,
  EventEnvelopeSchema,
  ErrorEnvelopeSchema,
  EnvelopeSchema,
  ClientMessageSchema,
  ServerMessageSchema,
  RequestIdSchema,
  MessageNameSchema,
  ErrorCodeSchema,
  ERROR_RETRY_POLICY,
  type CommandEnvelope,
  type ResponseEnvelope,
  type EventEnvelope,
  type ErrorEnvelope,
  type Envelope,
} from '@openmanager/protocol'
import { clientFixtures, serverFixtures } from './fixtures.js'

describe('public envelope schemas', () => {
  const fixtures = [
    { type: 'command', requestId: 'req-1', name: 'example.command', payload: { text: 'hello' } },
    { type: 'response', requestId: 'req-1', payload: null },
    { type: 'event', name: 'example.event', payload: [1, true, null, { text: 'hello' }] },
    { type: 'error', requestId: 'req-1', error: { code: 'internal', message: 'Example' } },
  ] satisfies Envelope[]

  it.each(fixtures)('validates a JSON-serialized $type envelope', (fixture) => {
    const received: unknown = JSON.parse(JSON.stringify(fixture))
    expect(EnvelopeSchema.parse(received)).toEqual(fixture)
  })

  it.each([
    null,
    [],
    {},
    { type: 'unknown', payload: null },
    { type: 'command', requestId: 123, name: 'example.command', payload: null },
    { type: 'command', requestId: 'req-1', payload: null },
    { type: 'response', payload: null },
    { type: 'event', name: 'example.event' },
    { type: 'event', name: 'example.event', payload: { nested: undefined } },
    { type: 'error', requestId: 'req-1', error: { code: 123, message: 'Example' } },
  ])('rejects malformed envelope %j', (input) => {
    expect(EnvelopeSchema.safeParse(input).success).toBe(false)
  })

  it('exports inferred types for each schema and a discriminated union', () => {
    expectTypeOf(CommandEnvelopeSchema.parse(fixtures[0])).toEqualTypeOf<CommandEnvelope>()
    expectTypeOf(ResponseEnvelopeSchema.parse(fixtures[1])).toEqualTypeOf<ResponseEnvelope>()
    expectTypeOf(EventEnvelopeSchema.parse(fixtures[2])).toEqualTypeOf<EventEnvelope>()
    expectTypeOf(ErrorEnvelopeSchema.parse(fixtures[3])).toEqualTypeOf<ErrorEnvelope>()
    const envelope = EnvelopeSchema.parse(fixtures[0])
    expectTypeOf(envelope).toEqualTypeOf<Envelope>()
    if (envelope.type === 'command') {
      expectTypeOf(envelope).toEqualTypeOf<CommandEnvelope>()
    }
  })
})

describe('wire contract', () => {
  it.each(clientFixtures)('round-trips a client command at server ingress: $name', (fixture) => {
    expect(ClientMessageSchema.parse(JSON.parse(JSON.stringify(fixture)))).toEqual(fixture)
    expect(ServerMessageSchema.safeParse(fixture).success).toBe(false)
  })

  it.each(serverFixtures)('round-trips a server $type at client ingress', (fixture) => {
    expect(ServerMessageSchema.parse(JSON.parse(JSON.stringify(fixture)))).toEqual(fixture)
    expect(ClientMessageSchema.safeParse(fixture).success).toBe(false)
  })

  it.each(['', ' ', ' req-1', 'req-1 ', 'req.1', 'réq', 'req\n', 'a'.repeat(129), null, 1])(
    'rejects invalid request identity %j in every correlated envelope',
    (requestId) => {
      expect(RequestIdSchema.safeParse(requestId).success).toBe(false)
      for (const type of ['command', 'response']) {
        expect(
          EnvelopeSchema.safeParse({ type, requestId, name: 'example.command', payload: null })
            .success,
        ).toBe(false)
      }
      if (requestId !== null) {
        expect(
          ServerMessageSchema.safeParse({
            type: 'error',
            requestId,
            error: { code: 'auth', message: 'Sign in' },
          }).success,
        ).toBe(false)
      }
    },
  )

  it('preserves opaque IDs including case and the maximum length', () => {
    for (const requestId of ['a', 'A_b-12', 'a'.repeat(128)]) {
      const command = ClientMessageSchema.parse({ ...clientFixtures[0], requestId })
      const response = ServerMessageSchema.parse({
        type: 'response',
        requestId: command.requestId,
        payload: null,
      })
      expect('requestId' in response && response.requestId).toBe(requestId)
    }
  })

  it.each(['', 'Session.create', 'session..create', 'session create', 'session.', 'a'.repeat(129)])(
    'rejects malformed command and event names: %j',
    (name) => {
      expect(MessageNameSchema.safeParse(name).success).toBe(false)
      expect(ClientMessageSchema.safeParse({ ...clientFixtures[0], name }).success).toBe(false)
      expect(ServerMessageSchema.safeParse({ type: 'event', name, payload: null }).success).toBe(
        false,
      )
    },
  )

  it('strips additive envelope/error fields but preserves domain JSON', () => {
    expect(ClientMessageSchema.parse({ ...clientFixtures[0], future: true })).toEqual(
      clientFixtures[0],
    )
    const error = { type: 'error', requestId: null, error: { code: 'auth', message: 'Sign in' } }
    expect(
      ServerMessageSchema.parse({
        ...error,
        future: true,
        error: { ...error.error, future: true },
      }),
    ).toEqual(error)
  })

  it('rejects unknown error codes and absent or empty error messages', () => {
    for (const error of [
      { code: 'example_error', message: 'Oops' },
      { code: 'auth' },
      { code: 'auth', message: '' },
    ]) {
      expect(
        ServerMessageSchema.safeParse({ type: 'error', requestId: 'req-1', error }).success,
      ).toBe(false)
    }
  })

  it('gives transient rejection and uncertain execution different retry policies', () => {
    expect(ERROR_RETRY_POLICY.unavailable).toBe('after_backoff')
    expect(ERROR_RETRY_POLICY.internal).toBe('reconcile')
    expect(ERROR_RETRY_POLICY.auth).toBe('after_auth')
    expect(ERROR_RETRY_POLICY.capability_missing).toBe('never')
    for (const code of ErrorCodeSchema.options) {
      expect(
        ServerMessageSchema.parse({
          type: 'error',
          requestId: 'req-1',
          error: { code, message: 'Example' },
        }),
      ).toMatchObject({ error: { code } })
    }
  })
})
