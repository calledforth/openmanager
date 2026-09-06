import { z } from 'zod'

/** Opaque, client-generated identity. Never trim or normalize IDs on receipt. */
export const RequestIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/)

/** Provider-neutral command/event name, e.g. `session.create`. */
export const MessageNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/)

export type RequestId = z.infer<typeof RequestIdSchema>
export type MessageName = z.infer<typeof MessageNameSchema>
