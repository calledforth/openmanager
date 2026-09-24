import { describe, expect, it } from 'vitest'
import {
  ClientMessageSchema,
  UPLOAD_PATH_PREFIX,
  UPLOAD_TICKET_CAPABILITY,
  UploadCommandSchemas,
  UploadResponseSchemas,
  UploadResultSchema,
} from '@openmanager/protocol'

const payload = {
  sessionId: 'session-1',
  name: 'screenshot.png',
  mimeType: 'image/png',
  sizeBytes: 1024,
}
const ticketCommand = (overrides: Record<string, unknown> = {}) => ({
  type: 'command',
  requestId: 'req-1',
  name: UPLOAD_TICKET_CAPABILITY,
  payload: { ...payload, ...overrides },
})

describe('upload ticket protocol', () => {
  it('declares one file for one session and carries no bytes', () => {
    const command = ticketCommand()
    expect(UploadCommandSchemas[UPLOAD_TICKET_CAPABILITY].parse(command)).toEqual(command)
    expect(ClientMessageSchema.parse(command)).toEqual(command)
    expect(
      UploadCommandSchemas[UPLOAD_TICKET_CAPABILITY].safeParse(ticketCommand({ data: 'AAAA' }))
        .success,
    ).toBe(false)
  })

  it.each([
    ['an empty name', { name: '   ' }],
    ['a name longer than a file name', { name: 'a'.repeat(256) }],
    ['a malformed MIME type', { mimeType: 'image' }],
    ['a MIME type with parameters', { mimeType: 'text/plain; charset=utf-8' }],
    ['an empty file', { sizeBytes: 0 }],
    ['a fractional size', { sizeBytes: 1.5 }],
    ['a missing session', { sessionId: '' }],
    ['no session and no workspace', { sessionId: undefined }],
    ['both a session and a workspace', { workspaceId: 'workspace-1' }],
    ['an empty workspace', { sessionId: undefined, workspaceId: '' }],
  ])('rejects %s', (_, overrides) => {
    expect(
      UploadCommandSchemas[UPLOAD_TICKET_CAPABILITY].safeParse(ticketCommand(overrides)).success,
    ).toBe(false)
  })

  it('lets a draft, which has no session yet, upload for its workspace', () => {
    const command = ticketCommand({ sessionId: undefined, workspaceId: 'workspace-1' })
    expect(UploadCommandSchemas[UPLOAD_TICKET_CAPABILITY].parse(command).payload).toEqual({
      workspaceId: 'workspace-1',
      name: 'screenshot.png',
      mimeType: 'image/png',
      sizeBytes: 1024,
    })
  })

  it('answers a relative upload path so local and remote routes agree', () => {
    const response = {
      type: 'response',
      requestId: 'req-1',
      payload: {
        ticket: 'abc',
        uploadPath: `${UPLOAD_PATH_PREFIX}abc`,
        expiresAt: '2026-09-19T10:00:00.000Z',
        maxBytes: 1024,
      },
    }
    expect(UploadResponseSchemas[UPLOAD_TICKET_CAPABILITY].parse(response)).toEqual(response)
  })

  it('names the artifact a message will reference', () => {
    const result = { artifactId: 'artifact-1', workspaceId: 'workspace-1', ...payload }
    expect(UploadResultSchema.parse(result)).toEqual(result)
    expect(UploadResultSchema.safeParse({ ...result, storageKey: 'uploads/x' }).success).toBe(false)
    // A draft's upload is held for the workspace until a session claims it.
    const held = { ...result, sessionId: undefined }
    expect(UploadResultSchema.parse(held)).toEqual(held)
    expect(UploadResultSchema.safeParse({ ...held, workspaceId: undefined }).success).toBe(false)
  })
})
