import { z } from 'zod'

export const ErrorCodeSchema = z.enum([
  'auth',
  'validation',
  'not_found',
  'conflict',
  'capability_missing',
  'protocol_incompatible',
  'unavailable',
  'internal',
])

export type ErrorCode = z.infer<typeof ErrorCodeSchema>
export type ErrorRetryPolicy =
  | 'after_auth'
  | 'after_change'
  | 'after_backoff'
  | 'after_upgrade'
  | 'never'
  | 'reconcile'

/** Policy for a NEW attempt after a terminal error, not for replaying a request ID. */
export const ERROR_RETRY_POLICY = {
  auth: 'after_auth',
  validation: 'after_change',
  not_found: 'after_change',
  conflict: 'after_change',
  capability_missing: 'never',
  protocol_incompatible: 'after_upgrade',
  unavailable: 'after_backoff',
  internal: 'reconcile',
} as const satisfies Record<ErrorCode, ErrorRetryPolicy>

export const ProtocolErrorSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string().min(1).max(4096),
  /** Specialized error schemas validate the shape for codes that define details. */
  details: z.json().optional(),
})

export type ProtocolError = z.infer<typeof ProtocolErrorSchema>
