import { z } from 'zod'

// These are structural envelopes. Domain payloads and protocol semantics are
// defined separately as the environment protocol is developed.
export const CommandEnvelopeSchema = z.object({
  type: z.literal('command'),
  requestId: z.string(),
  name: z.string(),
  payload: z.json(),
})

export const ResponseEnvelopeSchema = z.object({
  type: z.literal('response'),
  requestId: z.string(),
  payload: z.json(),
})

export const EventEnvelopeSchema = z.object({
  type: z.literal('event'),
  name: z.string(),
  payload: z.json(),
})

export const ErrorEnvelopeSchema = z.object({
  type: z.literal('error'),
  requestId: z.string(),
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
})

export const EnvelopeSchema = z.discriminatedUnion('type', [
  CommandEnvelopeSchema,
  ResponseEnvelopeSchema,
  EventEnvelopeSchema,
  ErrorEnvelopeSchema,
])

export type CommandEnvelope = z.infer<typeof CommandEnvelopeSchema>
export type ResponseEnvelope = z.infer<typeof ResponseEnvelopeSchema>
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>
export type Envelope = z.infer<typeof EnvelopeSchema>
