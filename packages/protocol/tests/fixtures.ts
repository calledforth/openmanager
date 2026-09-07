import type { ClientMessage, ServerMessage } from '@openmanager/protocol'

// Shared wire examples run through both Node and an isolated browser bundle.
export const clientFixtures = [
  { type: 'command', requestId: 'req-1', name: 'example.command', payload: { text: 'hello' } },
  { type: 'command', requestId: 'REQ_2', name: 'example.empty', payload: null },
  { type: 'pong', heartbeatId: 'hb-1' },
] satisfies ClientMessage[]

export const serverFixtures = [
  { type: 'response', requestId: 'req-1', payload: { accepted: true } },
  { type: 'response', requestId: 'REQ_2', payload: null },
  { type: 'event', name: 'example.event', payload: [1, true, null, { text: 'hello' }] },
  { type: 'error', requestId: 'req-1', error: { code: 'validation', message: 'Invalid payload' } },
  { type: 'error', requestId: 'REQ_2', error: { code: 'unavailable', message: 'Try later' } },
  { type: 'error', requestId: null, error: { code: 'validation', message: 'Invalid request ID' } },
  { type: 'ping', heartbeatId: 'hb-1' },
] satisfies ServerMessage[]
