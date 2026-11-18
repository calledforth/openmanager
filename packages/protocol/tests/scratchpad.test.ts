import { describe, expect, it } from 'vitest'
import {
  COMMAND_ACCESS,
  SCRATCHPAD_MAX_BYTES,
  ScratchpadChangedEventSchema,
  ScratchpadCommandSchemas,
  ScratchpadSchema,
  ServerMessageSchema,
  scratchpadBytes,
} from '@openmanager/protocol'

const scratchpad = {
  workspaceId: 'workspace-1',
  exists: true,
  content: '# Plan\n',
  tooLarge: false,
  version: 'abc',
  modifiedAt: '2026-11-18T10:00:00.000Z',
  lastEdit: {
    by: { kind: 'agent', sessionId: 'session-1', providerId: 'claude' },
    at: '2026-11-18T10:00:00.000Z',
  },
  shareWithAgents: true,
} as const

describe('the scratchpad on the wire', () => {
  it('names who changed it in one of four ways', () => {
    for (const by of [
      { kind: 'you' },
      { kind: 'client', clientId: 'client-2' },
      { kind: 'agent', sessionId: 'session-1', providerId: 'claude' },
      { kind: 'external' },
    ]) {
      expect(
        ScratchpadSchema.safeParse({ ...scratchpad, lastEdit: { by, at: scratchpad.modifiedAt } })
          .success,
      ).toBe(true)
    }
    expect(
      ScratchpadSchema.safeParse({
        ...scratchpad,
        lastEdit: { by: { kind: 'robot' }, at: scratchpad.modifiedAt },
      }).success,
    ).toBe(false)
  })

  it('saves from a version, or from no file at all', () => {
    const save = (baseVersion: unknown) =>
      ScratchpadCommandSchemas['scratchpad.save'].safeParse({
        type: 'command',
        requestId: 'req-1',
        name: 'scratchpad.save',
        payload: { workspaceId: 'workspace-1', content: 'x', baseVersion },
      }).success
    expect(save('abc')).toBe(true)
    expect(save(null)).toBe(true)
    expect(save(undefined)).toBe(false)
  })

  it('sends a change as a reading any client can tell apart', () => {
    const event = { type: 'event', name: 'scratchpad.changed', payload: { scratchpad } }
    expect(ScratchpadChangedEventSchema.parse(event).payload.scratchpad).toEqual(scratchpad)
    expect(ServerMessageSchema.safeParse(event).success).toBe(true)
  })

  it('reads with `read` and writes with `operate`', () => {
    expect(COMMAND_ACCESS['scratchpad.get']).toBe('read')
    expect(COMMAND_ACCESS['scratchpad.save']).toBe('operate')
    expect(COMMAND_ACCESS['scratchpad.sharing.set']).toBe('operate')
  })

  it('counts its limit in UTF-8 bytes', () => {
    expect(scratchpadBytes('é')).toBe(2)
    expect(scratchpadBytes('x'.repeat(SCRATCHPAD_MAX_BYTES))).toBe(SCRATCHPAD_MAX_BYTES)
  })
})
