import { describe, expect, it } from 'vitest'
import {
  CLIENT_LABEL_MAX_LENGTH,
  ClientCommandSchemas,
  ClientLabelSchema,
  ClientListChangedEventSchema,
  ClientResponseSchemas,
  ServerMessageSchema,
} from '@openmanager/protocol'

const client = {
  clientId: 'client-1',
  label: 'Phone',
  kind: 'paired',
  capabilities: ['read', 'operate'],
  createdAt: '2026-10-01T10:00:00.000Z',
  lastSeenAt: null,
  expiresAt: '2026-10-31T10:00:00.000Z',
  connected: false,
} as const

describe('client labels', () => {
  it('trims, and refuses blank, overlong and control-character names', () => {
    expect(ClientLabelSchema.parse('  Laptop  ')).toBe('Laptop')
    expect(ClientLabelSchema.parse('Raj’s phone 📱')).toBe('Raj’s phone 📱')
    expect(ClientLabelSchema.safeParse('   ').success).toBe(false)
    expect(ClientLabelSchema.safeParse('').success).toBe(false)
    expect(ClientLabelSchema.safeParse('x'.repeat(CLIENT_LABEL_MAX_LENGTH)).success).toBe(true)
    expect(ClientLabelSchema.safeParse('x'.repeat(CLIENT_LABEL_MAX_LENGTH + 1)).success).toBe(false)
    expect(ClientLabelSchema.safeParse('two\nlines').success).toBe(false)
    expect(ClientLabelSchema.safeParse('bell\u0007').success).toBe(false)
    // Format characters could make one device's name read as another's.
    expect(ClientLabelSchema.safeParse('a‮b').success).toBe(false)
    expect(ClientLabelSchema.safeParse('a‍b').success).toBe(false)
  })
})

describe('client commands', () => {
  const envelope = { type: 'command', requestId: 'req-1' } as const

  it('accept their payloads and refuse extra fields', () => {
    expect(
      ClientCommandSchemas['client.rename'].parse({
        ...envelope,
        name: 'client.rename',
        payload: { clientId: 'client-1', label: ' Phone ' },
      }).payload.label,
    ).toBe('Phone')
    expect(
      ClientCommandSchemas['client.revoke'].safeParse({
        ...envelope,
        name: 'client.revoke',
        payload: { clientId: 'client-1', force: true },
      }).success,
    ).toBe(false)
    expect(
      ClientCommandSchemas['client.revoke_others'].safeParse({
        ...envelope,
        name: 'client.revoke_others',
        payload: null,
      }).success,
    ).toBe(true)
  })

  it('answer with lists that carry no credential, except the rotation itself', () => {
    const list = ClientResponseSchemas['client.list'].parse({
      type: 'response',
      requestId: 'req-1',
      payload: { clients: [client], currentClientId: 'client-1', omitted: 0 },
    })
    expect(list.payload.clients[0]).toEqual(client)
    expect(
      ClientResponseSchemas['client.list'].safeParse({
        type: 'response',
        requestId: 'req-1',
        payload: {
          clients: [{ ...client, credential: 'omc1.x' }],
          currentClientId: 'client-1',
          omitted: 0,
        },
      }).success,
    ).toBe(false)
    expect(
      ClientResponseSchemas['client.owner.rotate'].safeParse({
        type: 'response',
        requestId: 'req-1',
        payload: { client: { ...client, kind: 'owner' }, credential: 'not-a-credential' },
      }).success,
    ).toBe(false)
  })

  it('carry the list in a server event', () => {
    const event = {
      type: 'event',
      name: 'client.list.changed',
      payload: { clients: [client], currentClientId: 'client-2', omitted: 0 },
    }
    expect(ServerMessageSchema.safeParse(event).success).toBe(true)
    expect(ClientListChangedEventSchema.parse(event).payload.currentClientId).toBe('client-2')
  })
})
