import { z } from 'zod'
import { ProtocolErrorSchema } from './errors.js'
import { MessageNameSchema, RequestIdSchema } from './primitives.js'

// Domain payloads are validated by their message family after envelope parsing.
export const CommandEnvelopeSchema = z.object({
  type: z.literal('command'),
  requestId: RequestIdSchema,
  name: MessageNameSchema,
  payload: z.json(),
})

export const ResponseEnvelopeSchema = z.object({
  type: z.literal('response'),
  requestId: RequestIdSchema,
  payload: z.json(),
})

export const EventEnvelopeSchema = z.object({
  type: z.literal('event'),
  name: MessageNameSchema,
  payload: z.json(),
})

export const ErrorEnvelopeSchema = z.object({
  type: z.literal('error'),
  // null means a connection-level or malformed-message error with no safe ID.
  requestId: RequestIdSchema.nullable(),
  error: ProtocolErrorSchema,
})

export const EnvelopeSchema = z.discriminatedUnion('type', [
  CommandEnvelopeSchema,
  ResponseEnvelopeSchema,
  EventEnvelopeSchema,
  ErrorEnvelopeSchema,
])

/** Use at the server ingress. Clients send commands only. */
export const ClientMessageSchema = CommandEnvelopeSchema
/** Use at the client ingress. Events do not settle pending commands. */
export const ServerMessageSchema = z.discriminatedUnion('type', [
  ResponseEnvelopeSchema,
  EventEnvelopeSchema,
  ErrorEnvelopeSchema,
])

export type CommandEnvelope = z.infer<typeof CommandEnvelopeSchema>
export type ResponseEnvelope = z.infer<typeof ResponseEnvelopeSchema>
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>
export type Envelope = z.infer<typeof EnvelopeSchema>
export type ClientMessage = z.infer<typeof ClientMessageSchema>
export type ServerMessage = z.infer<typeof ServerMessageSchema>
