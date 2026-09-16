import { z } from 'zod'
import { ProofCommandSchemas } from './commands.js'
import { ComposerCommandSchemas } from './composer.js'
import { ErrorEnvelopeSchema } from './envelopes.js'
import { ProtocolErrorSchema } from './errors.js'
import { HEARTBEAT_CAPABILITY } from './heartbeat.js'
import { PROVIDER_PROBE_CAPABILITY } from './providers.js'
import type { ReplayCommand } from './replay.js'

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

export const ACCESS_PRESETS = Object.freeze({
  read_only: ['read'],
  standard: ['read', 'operate'],
} as const satisfies Record<string, readonly AccessCapability[]>)

/** Every command name the protocol package knows about. */
export type CommandName =
  | 'protocol.handshake'
  | typeof HEARTBEAT_CAPABILITY
  | typeof PROVIDER_PROBE_CAPABILITY
  | keyof typeof ProofCommandSchemas
  | keyof typeof ComposerCommandSchemas
  | ReplayCommand['name']

/**
 * The capability each command requires, or `null` for connection plumbing
 * that runs after the socket is authenticated but is not a grant check.
 *
 * The mapping is total: `satisfies` fails to compile when a command is added
 * without a row, and `tests/access.test.ts` checks the key set against the
 * schemas at runtime.
 */
export const COMMAND_ACCESS = Object.freeze({
  'protocol.handshake': null,
  [HEARTBEAT_CAPABILITY]: null,
  'environment.get': 'read',
  'workspace.list': 'read',
  'workspace.icon': 'read',
  'session.list': 'read',
  'session.open': 'read',
  'session.history': 'read',
  'subscription.subscribe': 'read',
  'subscription.unsubscribe': 'read',
  'subscription.replay': 'read',
  'provider.catalog.get': 'read',
  [PROVIDER_PROBE_CAPABILITY]: 'read',
  'composer.preferences.get': 'read',
  'session.create': 'operate',
  'session.rename': 'operate',
  'session.delete': 'operate',
  'workspace.add': 'operate',
  'workspace.remove': 'operate',
  'composer.preferences.set': 'operate',
  'turn.send': 'agent',
  'turn.interrupt': 'agent',
  'interaction.respond': 'agent',
  'composer.model.set': 'agent',
  'composer.mode.set': 'agent',
  'composer.config_option.set': 'agent',
} as const satisfies Record<CommandName, AccessCapability | null>)

/**
 * The capability a command name requires. `null` means the command is
 * connection plumbing; `undefined` means the name is not a protocol command.
 */
export function requiredAccess(name: string): AccessCapability | null | undefined {
  return Object.hasOwn(COMMAND_ACCESS, name) ? COMMAND_ACCESS[name as CommandName] : undefined
}

export function hasAccess(
  grant: readonly AccessCapability[],
  capability: AccessCapability | null,
): boolean {
  return capability === null || grant.includes(capability)
}

/** The error a command receives when the caller's grant lacks its capability. */
export const AccessDeniedErrorSchema = ErrorEnvelopeSchema.extend({
  error: ProtocolErrorSchema.extend({
    code: z.literal('capability_missing'),
    details: z.object({ requiredCapability: AccessCapabilitySchema }),
  }),
})
export type AccessDeniedError = z.infer<typeof AccessDeniedErrorSchema>

export function accessDenied(requestId: string, capability: AccessCapability): AccessDeniedError {
  return {
    type: 'error',
    requestId,
    error: {
      code: 'capability_missing',
      message: `This command requires the ${capability} capability.`,
      details: { requiredCapability: capability },
    },
  }
}
