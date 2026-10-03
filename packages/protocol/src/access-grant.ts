import { z } from 'zod'

/**
 * Access capabilities are what a client's credential grants. They are distinct
 * from the protocol feature capabilities advertised by `/bootstrap` and checked
 * by the handshake, which describe what the server implements.
 *
 * The set and the command mapping are fixed by
 * `docs/decisions/capability-scopes-and-credentials.md`.
 */
export const ACCESS_CAPABILITIES = ['read', 'operate', 'agent', 'terminal', 'admin'] as const
export const AccessCapabilitySchema = z.enum(ACCESS_CAPABILITIES)
export type AccessCapability = z.infer<typeof AccessCapabilitySchema>

/** A grant is a set of capabilities. `read` is required for a connection to be useful at all. */
export const AccessGrantSchema = z
  .array(AccessCapabilitySchema)
  .max(ACCESS_CAPABILITIES.length)
  .superRefine((items, ctx) => {
    if (new Set(items).size !== items.length) {
      ctx.addIssue({ code: 'custom', message: 'Capabilities must be unique' })
    }
    if (!items.includes('read')) {
      ctx.addIssue({ code: 'custom', message: 'A grant must include read' })
    }
  })
export type AccessGrant = z.infer<typeof AccessGrantSchema>
