import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  ProofCommandSchema,
  ProofEventSchema,
  ProofEventSchemas,
  ProofCommandSchemas,
  SubscriptionScopeSchema,
  InteractionResponseSchema,
  parseProofResult,
  type ProofResponse,
} from '@openmanager/protocol'
import {
  proofCommands,
  proofResponses,
  proofEvents,
  environmentScope,
  sessionScope,
  threadScope,
} from './proof-fixtures.js'

describe('proof slice wire families', () => {
  it('covers every public command and event family with a wire example', () => {
    expect(proofCommands.map((c) => c.name).sort()).toEqual(Object.keys(ProofCommandSchemas).sort())
    expect(proofEvents.map((e) => e.name).sort()).toEqual(Object.keys(ProofEventSchemas).sort())
  })
  it.each(proofCommands)('validates $name and its correlated result', (command) => {
    expect(ProofCommandSchema.parse(JSON.parse(JSON.stringify(command)))).toEqual(command)
    const response = proofResponses[command.name]
    expect(parseProofResult(command, JSON.parse(JSON.stringify(response)))).toEqual(response)
    expect(() => parseProofResult(command, { ...response, requestId: 'another-request' })).toThrow()
    const error = {
      type: 'error',
      requestId: command.requestId,
      error: { code: 'internal', message: 'Failed' },
    }
    expect(parseProofResult(command, error)).toEqual(error)
    expect(() => parseProofResult(command, { ...error, requestId: null })).toThrow()
  })
  it.each(proofEvents)('validates the $name event through JSON', (event) => {
    expect(ProofEventSchema.parse(JSON.parse(JSON.stringify(event)))).toEqual(event)
  })
  it('selects response payload validation from the pending command', () => {
    expect(() =>
      parseProofResult(
        { name: 'session.list', requestId: 'r-2' },
        proofResponses['workspace.list'],
      ),
    ).toThrow()
    const result = parseProofResult(
      { name: 'session.create', requestId: 'r-4' },
      proofResponses['session.create'],
    )
    if (result.type === 'response')
      expectTypeOf(result).toEqualTypeOf<ProofResponse<'session.create'>>()
  })
  it.each([environmentScope, sessionScope, threadScope])(
    'accepts an exact $type subscription scope',
    (scope) => {
      expect(SubscriptionScopeSchema.parse(scope)).toEqual(scope)
    },
  )
  it.each([
    { ...environmentScope, threadId: 'thread-1' },
    { ...sessionScope, threadId: 'thread-1' },
    { type: 'thread', environmentId: 'env-1', threadId: 'thread-1' },
    { type: 'workspace', environmentId: 'env-1', workspaceId: 'workspace-1' },
  ])('rejects ambiguous or unsupported scopes: %j', (scope) => {
    expect(SubscriptionScopeSchema.safeParse(scope).success).toBe(false)
  })
  it('rejects wrong event scopes, invalid timestamps and missing host identity', () => {
    const event = proofEvents.find((e) => e.name === 'message.delta')!
    for (const invalid of [
      { ...event, scope: environmentScope },
      { ...event, timestamp: 'yesterday' },
      { ...event, eventId: '' },
      { ...event, payload: { ...event.payload, messageId: '' } },
    ]) {
      expect(ProofEventSchema.safeParse(invalid).success).toBe(false)
    }
  })
  it('rejects unknown commands, incomplete targets and the wrong interaction outcome', () => {
    for (const invalid of [
      { type: 'command', requestId: 'r', name: 'terminal.open', payload: null },
      {
        type: 'command',
        requestId: 'r',
        name: 'turn.interrupt',
        payload: { threadId: 'thread-1' },
      },
      {
        type: 'command',
        requestId: 'r',
        name: 'turn.send',
        payload: { sessionId: 'session-1', threadId: 'thread-1', text: '' },
      },
    ])
      expect(ProofCommandSchema.safeParse(invalid).success).toBe(false)
    expect(
      InteractionResponseSchema.safeParse({
        kind: 'permission',
        interactionId: 'i',
        outcome: { outcome: 'accepted' },
      }).success,
    ).toBe(false)
    expect(
      InteractionResponseSchema.parse({
        kind: 'plan',
        interactionId: 'i',
        outcome: { outcome: 'accepted' },
      }),
    ).toMatchObject({ kind: 'plan' })
  })
})
