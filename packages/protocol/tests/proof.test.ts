import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  ProofCommandSchema,
  ProofEventSchema,
  ProofEventSchemas,
  ProofCommandSchemas,
  ProofResponseSchemas,
  ServerMessageSchema,
  SubscriptionScopeSchema,
  InteractionResponseSchema,
  WorkspaceSchema,
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
  it('trims rename titles, accepts null and rejects empty or oversized titles', () => {
    const rename = (title: unknown) =>
      ProofCommandSchemas['session.rename'].safeParse({
        type: 'command',
        requestId: 'rename',
        name: 'session.rename',
        payload: { sessionId: 'session-1', title },
      })
    expect(rename('  Name  ')).toMatchObject({
      success: true,
      data: { payload: { title: 'Name' } },
    })
    expect(rename(null).success).toBe(true)
    expect(rename(' ').success).toBe(false)
    expect(rename('x'.repeat(513)).success).toBe(false)
  })
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
  it('preserves event-family identity and scope at generic server ingress', () => {
    const event = proofEvents.find((candidate) => candidate.name === 'turn.interrupted')!
    expect(ServerMessageSchema.parse(event)).toEqual(event)
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

  it('accepts a workspace from an environment that predates activity and capabilities', () => {
    const legacy = {
      workspaceId: 'ws-1',
      name: 'repo',
      path: '/repo',
      lastUsedAt: null,
      exists: true,
    }
    expect(WorkspaceSchema.parse(legacy)).toEqual({
      ...legacy,
      lastActivityAt: null,
      capabilities: { git: false, providers: [] },
    })
  })
})

it('requires explicit session routing and accepts an optional nonempty first message', () => {
  const command = {
    type: 'command',
    requestId: 'create',
    name: 'session.create',
    payload: {
      environmentId: 'env',
      workspaceId: 'workspace',
      providerId: 'opencode',
      firstMessage: 'hello',
    },
  }
  expect(ProofCommandSchemas['session.create'].safeParse(command).success).toBe(true)
  for (const key of ['environmentId', 'workspaceId', 'providerId']) {
    expect(
      ProofCommandSchemas['session.create'].safeParse({
        ...command,
        payload: { ...command.payload, [key]: undefined },
      }).success,
    ).toBe(false)
  }
  expect(
    ProofCommandSchemas['session.create'].safeParse({
      ...command,
      payload: { ...command.payload, firstMessage: '' },
    }).success,
  ).toBe(false)
})

describe('turn.send command ids', () => {
  const send = (payload: Record<string, unknown>) => ({
    type: 'command',
    requestId: 'r-6',
    name: 'turn.send',
    payload: { sessionId: 'session-1', threadId: 'thread-1', text: 'Hello', ...payload },
  })

  it('carries an optional command id and rejects an empty one', () => {
    expect(ProofCommandSchemas['turn.send'].safeParse(send({ commandId: 'cmd-1' })).success).toBe(
      true,
    )
    // Omitted by a client that predates the id; the environment mints one.
    expect(ProofCommandSchemas['turn.send'].safeParse(send({})).success).toBe(true)
    expect(ProofCommandSchemas['turn.send'].safeParse(send({ commandId: '' })).success).toBe(false)
    expect(ProofCommandSchemas['turn.send'].safeParse(send({ commandId: ' ' })).success).toBe(false)
  })

  it('echoes the command id on the response and the turn.started event', () => {
    const started = proofEvents.find((event) => event.name === 'turn.started')!
    const payload = { ...started.payload, commandId: 'cmd-1' }
    expect(
      ProofEventSchemas['turn.started'].parse({ ...started, payload }).payload,
    ).toMatchObject({ commandId: 'cmd-1' })
    expect(
      ProofResponseSchemas['turn.send'].parse({ type: 'response', requestId: 'r-6', payload })
        .payload,
    ).toMatchObject({ commandId: 'cmd-1' })
    // An environment that predates the echo answers the same shape without it.
    expect(
      ProofResponseSchemas['turn.send'].safeParse({
        type: 'response',
        requestId: 'r-6',
        payload: started.payload,
      }).success,
    ).toBe(true)
  })
})
