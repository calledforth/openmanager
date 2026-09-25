import { describe, expect, it } from 'vitest'
import {
  ACCESS_CAPABILITIES,
  ACCESS_PRESETS,
  AccessDeniedErrorSchema,
  AccessGrantSchema,
  COMMAND_ACCESS,
  ComposerCommandSchemas,
  ERROR_RETRY_POLICY,
  HEARTBEAT_CAPABILITY,
  PROVIDER_PROBE_CAPABILITY,
  ProofCommandSchemas,
  ServerMessageSchema,
  UploadCommandSchemas,
  accessDenied,
  hasAccess,
  requiredAccess,
} from '@openmanager/protocol'

describe('command access mapping', () => {
  it('maps every command the protocol package defines and nothing else', () => {
    const commandNames = [
      'protocol.handshake',
      HEARTBEAT_CAPABILITY,
      PROVIDER_PROBE_CAPABILITY,
      'subscription.replay',
      ...Object.keys(ProofCommandSchemas),
      ...Object.keys(ComposerCommandSchemas),
      ...Object.keys(UploadCommandSchemas),
    ].sort()
    expect(Object.keys(COMMAND_ACCESS).sort()).toEqual(commandNames)
  })

  it('assigns only known capabilities, and plumbing commands none', () => {
    for (const [name, capability] of Object.entries(COMMAND_ACCESS)) {
      if (name === 'protocol.handshake' || name === HEARTBEAT_CAPABILITY) {
        expect(capability).toBeNull()
      } else {
        expect(ACCESS_CAPABILITIES).toContain(capability)
      }
    }
  })

  it('follows the decision record for the commands that exist today', () => {
    expect(COMMAND_ACCESS).toMatchObject({
      'environment.get': 'read',
      'session.open': 'read',
      'subscription.subscribe': 'read',
      'subscription.replay': 'read',
      'provider.probe': 'read',
      'composer.preferences.get': 'read',
      'session.create': 'operate',
      'session.rename': 'operate',
      'session.delete': 'operate',
      'session.settle': 'operate',
      'workspace.add': 'operate',
      'workspace.remove': 'operate',
      'composer.preferences.set': 'operate',
      'upload.ticket.create': 'operate',
      'turn.send': 'agent',
      'turn.interrupt': 'agent',
      'interaction.respond': 'agent',
      'composer.model.set': 'agent',
      'composer.mode.set': 'agent',
      'composer.config_option.set': 'agent',
    })
  })

  it('answers lookups for plumbing, mapped and unknown names distinctly', () => {
    expect(requiredAccess('protocol.handshake')).toBeNull()
    expect(requiredAccess('turn.send')).toBe('agent')
    expect(requiredAccess('unknown.command')).toBeUndefined()
    expect(requiredAccess('toString')).toBeUndefined()
    expect(requiredAccess('__proto__')).toBeUndefined()
  })

  it('checks a grant against a requirement', () => {
    expect(hasAccess(['read'], null)).toBe(true)
    expect(hasAccess(['read'], 'read')).toBe(true)
    expect(hasAccess(['read'], 'agent')).toBe(false)
    expect(hasAccess(['read', 'operate', 'agent'], 'agent')).toBe(true)
  })
})

describe('grants', () => {
  it('requires read, rejects duplicates and unknown names, and validates the presets', () => {
    expect(AccessGrantSchema.safeParse([]).success).toBe(false)
    expect(AccessGrantSchema.safeParse(['operate']).success).toBe(false)
    expect(AccessGrantSchema.safeParse(['read', 'read']).success).toBe(false)
    expect(AccessGrantSchema.safeParse(['read', 'root']).success).toBe(false)
    expect(AccessGrantSchema.parse(['read', 'admin'])).toEqual(['read', 'admin'])
    for (const preset of Object.values(ACCESS_PRESETS)) {
      expect(AccessGrantSchema.parse([...preset])).toEqual(preset)
    }
    expect(ACCESS_PRESETS.standard).not.toContain('agent')
    expect(ACCESS_PRESETS.standard).not.toContain('terminal')
    expect(ACCESS_PRESETS.standard).not.toContain('admin')
  })
})

describe('access denied error', () => {
  it('is a terminal capability_missing error naming the missing capability', () => {
    const error = accessDenied('req-1', 'agent')
    expect(AccessDeniedErrorSchema.parse(JSON.parse(JSON.stringify(error)))).toEqual(error)
    expect(ServerMessageSchema.parse(error)).toEqual(error)
    expect(error.error.details).toEqual({ requiredCapability: 'agent' })
    expect(ERROR_RETRY_POLICY[error.error.code]).toBe('never')
  })
})
