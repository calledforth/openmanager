import { z } from 'zod'
import { ErrorCodeSchema, ProtocolErrorSchema } from './errors.js'
import {
  CommandEnvelopeSchema,
  ErrorEnvelopeSchema,
  ResponseEnvelopeSchema,
} from './envelopes.js'
import { EntityIdSchema } from './domains.js'
import { MessageNameSchema, RequestIdSchema } from './primitives.js'

/** Increment only when the wire contract changes incompatibly. */
export const PROTOCOL_VERSION = 1 as const

export const ProtocolVersionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
export const CapabilitySchema = MessageNameSchema
export const CapabilityListSchema = z.array(CapabilitySchema).max(256).superRefine((items, ctx) => {
  const seen = new Set<string>()
  for (const [index, item] of items.entries()) {
    if (seen.has(item)) {
      ctx.addIssue({ code: 'custom', path: [index], message: 'Capabilities must be unique' })
    }
    seen.add(item)
  }
})

/**
 * HTTP bootstrap fields owned by the protocol package. Unknown fields are
 * preserved so later bootstrap work can add connection metadata additively.
 */
export const BootstrapResponseSchema = z
  .object({
    protocolVersion: ProtocolVersionSchema,
    environmentId: EntityIdSchema,
    capabilities: CapabilityListSchema,
  })
  .catchall(z.json())

export type ProtocolVersion = z.infer<typeof ProtocolVersionSchema>
export type Capability = z.infer<typeof CapabilitySchema>
export type BootstrapResponse = z.infer<typeof BootstrapResponseSchema>

export type BootstrapRequirements = {
  protocolVersion?: ProtocolVersion
  requiredCapabilities?: readonly Capability[]
}

export type BootstrapState =
  | { state: 'ready'; bootstrap: BootstrapResponse }
  | {
      state: 'incompatible_protocol'
      bootstrap: BootstrapResponse
      clientProtocolVersion: ProtocolVersion
      serverProtocolVersion: ProtocolVersion
    }
  | {
      state: 'capability_missing'
      bootstrap: BootstrapResponse
      missingCapabilities: Capability[]
    }

/** Derive the complete client gate from one validated bootstrap response. */
export function evaluateBootstrap(
  input: unknown,
  requirements: BootstrapRequirements = {},
): BootstrapState {
  const bootstrap = BootstrapResponseSchema.parse(input)
  const clientProtocolVersion = ProtocolVersionSchema.parse(
    requirements.protocolVersion ?? PROTOCOL_VERSION,
  )
  if (bootstrap.protocolVersion !== clientProtocolVersion) {
    return {
      state: 'incompatible_protocol',
      bootstrap,
      clientProtocolVersion,
      serverProtocolVersion: bootstrap.protocolVersion,
    }
  }

  const requiredCapabilities = CapabilityListSchema.parse(requirements.requiredCapabilities ?? [])
  const available = new Set(bootstrap.capabilities)
  const missingCapabilities = requiredCapabilities.filter((capability) => !available.has(capability))
  if (missingCapabilities.length > 0) {
    return { state: 'capability_missing', bootstrap, missingCapabilities }
  }
  return { state: 'ready', bootstrap }
}

export const ProtocolHandshakeCommandSchema = CommandEnvelopeSchema.extend({
  name: z.literal('protocol.handshake'),
  payload: z.object({
    protocolVersion: ProtocolVersionSchema,
    requiredCapabilities: CapabilityListSchema,
  }),
})

// Version detection must not depend on the rest of the version-specific payload.
const ProtocolHandshakeVersionProbeSchema = CommandEnvelopeSchema.extend({
  name: z.literal('protocol.handshake'),
  payload: z.object({ protocolVersion: ProtocolVersionSchema }).catchall(z.json()),
})

export const ProtocolHandshakeResponseSchema = ResponseEnvelopeSchema.extend({
  payload: BootstrapResponseSchema,
})

const IncompatibleProtocolErrorSchema = ProtocolErrorSchema.extend({
  code: z.literal('protocol_incompatible'),
  details: z.object({
    clientProtocolVersion: ProtocolVersionSchema,
    serverProtocolVersion: ProtocolVersionSchema,
  }),
})
const MissingCapabilityErrorSchema = ProtocolErrorSchema.extend({
  code: z.literal('capability_missing'),
  details: z.object({ missingCapabilities: CapabilityListSchema.min(1) }),
})
const OtherHandshakeErrorSchema = ProtocolErrorSchema.extend({
  code: ErrorCodeSchema.exclude(['protocol_incompatible', 'capability_missing']),
})

export const ProtocolHandshakeErrorSchema = ErrorEnvelopeSchema.extend({
  requestId: RequestIdSchema,
  error: z.union([
    IncompatibleProtocolErrorSchema,
    MissingCapabilityErrorSchema,
    OtherHandshakeErrorSchema,
  ]),
})

export const ProtocolHandshakeResultSchema = z.union([
  ProtocolHandshakeResponseSchema,
  ProtocolHandshakeErrorSchema,
])

export type ProtocolHandshakeCommand = z.infer<typeof ProtocolHandshakeCommandSchema>
export type ProtocolHandshakeResponse = z.infer<typeof ProtocolHandshakeResponseSchema>
export type ProtocolHandshakeError = z.infer<typeof ProtocolHandshakeErrorSchema>
export type ProtocolHandshakeResult = z.infer<typeof ProtocolHandshakeResultSchema>

/** Produce the application-level result that a WebSocket host sends before dispatch. */
export function negotiateProtocolHandshake(
  input: unknown,
  bootstrapInput: unknown,
): ProtocolHandshakeResult {
  const versionProbe = ProtocolHandshakeVersionProbeSchema.parse(input)
  const bootstrap = BootstrapResponseSchema.parse(bootstrapInput)
  if (versionProbe.payload.protocolVersion !== bootstrap.protocolVersion) {
    return ProtocolHandshakeErrorSchema.parse({
      type: 'error',
      requestId: versionProbe.requestId,
      error: {
        code: 'protocol_incompatible',
        message: `Client protocol version ${versionProbe.payload.protocolVersion} is incompatible with server protocol version ${bootstrap.protocolVersion}`,
        details: {
          clientProtocolVersion: versionProbe.payload.protocolVersion,
          serverProtocolVersion: bootstrap.protocolVersion,
        },
      },
    })
  }

  const command = ProtocolHandshakeCommandSchema.parse(input)
  const state = evaluateBootstrap(bootstrap, {
    protocolVersion: command.payload.protocolVersion,
    requiredCapabilities: command.payload.requiredCapabilities,
  })

  // The early version check makes this unreachable for a valid host bootstrap.
  if (state.state === 'incompatible_protocol') throw new Error('Protocol version changed during handshake')
  if (state.state === 'capability_missing') {
    return ProtocolHandshakeErrorSchema.parse({
      type: 'error',
      requestId: command.requestId,
      error: {
        code: 'capability_missing',
        message: 'Environment is missing one or more required capabilities',
        details: { missingCapabilities: state.missingCapabilities },
      },
    })
  }
  return ProtocolHandshakeResponseSchema.parse({
    type: 'response',
    requestId: command.requestId,
    payload: state.bootstrap,
  })
}

/** Validate a handshake result against the request that opened the socket. */
export function parseProtocolHandshakeResult(
  commandInput: unknown,
  resultInput: unknown,
): ProtocolHandshakeResult {
  const command = ProtocolHandshakeCommandSchema.parse(commandInput)
  const result = ProtocolHandshakeResultSchema.parse(resultInput)
  if (result.requestId !== command.requestId) {
    throw new Error('Protocol handshake result does not match the pending request ID')
  }
  if (result.type === 'response') {
    const state = evaluateBootstrap(result.payload, {
      protocolVersion: command.payload.protocolVersion,
      requiredCapabilities: command.payload.requiredCapabilities,
    })
    if (state.state === 'incompatible_protocol') {
      throw new Error('Protocol handshake accepted an incompatible protocol version')
    }
    if (state.state === 'capability_missing') {
      throw new Error('Protocol handshake accepted without required capabilities')
    }
  }
  if (
    result.type === 'error' &&
    result.error.code === 'protocol_incompatible' &&
    (result.error.details.clientProtocolVersion !== command.payload.protocolVersion ||
      result.error.details.serverProtocolVersion === command.payload.protocolVersion)
  ) {
    throw new Error('Protocol handshake rejection contradicts the requested protocol version')
  }
  if (
    result.type === 'error' &&
    result.error.code === 'capability_missing' &&
    result.error.details.missingCapabilities.some(
      (capability) => !command.payload.requiredCapabilities.includes(capability),
    )
  ) {
    throw new Error('Protocol handshake rejection names an unrequested capability')
  }
  return result
}
