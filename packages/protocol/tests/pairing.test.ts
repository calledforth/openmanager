import { describe, expect, it } from 'vitest'
import {
  COMMAND_ACCESS,
  ClientLabelSchema,
  PAIRING_TOKEN_ALPHABET,
  PAIRING_TOKEN_LENGTH,
  PairingCommandSchemas,
  PairingExchangeRequestSchema,
  formatPairingToken,
  normalizePairingToken,
} from '@openmanager/protocol'

describe('pairing tokens', () => {
  it('uses 32 symbols with no look-alikes, twelve of them', () => {
    expect(new Set(PAIRING_TOKEN_ALPHABET).size).toBe(32)
    expect(PAIRING_TOKEN_ALPHABET).not.toMatch(/[01IO]/)
    expect(PAIRING_TOKEN_LENGTH).toBe(12)
  })

  it('normalizes what a person types and refuses anything else', () => {
    expect(normalizePairingToken('abcd-efgh-jkmn')).toBe('ABCDEFGHJKMN')
    expect(normalizePairingToken(' ABCD EFGH JKMN ')).toBe('ABCDEFGHJKMN')
    expect(normalizePairingToken('ABCDEFGHJKM')).toBeUndefined()
    expect(normalizePairingToken('ABCDEFGHJKMNP')).toBeUndefined()
    expect(normalizePairingToken('ABCDEFGHJKM0')).toBeUndefined()
    expect(normalizePairingToken('ABCDEFGHJKMI')).toBeUndefined()
    expect(normalizePairingToken('-'.repeat(100))).toBeUndefined()
  })

  it('formats a token in groups of four', () => {
    expect(formatPairingToken('ABCDEFGHJKMN')).toBe('ABCD-EFGH-JKMN')
  })
})

describe('pairing commands', () => {
  it('need admin to hand out access, and only read to redeem a link for oneself', () => {
    expect(COMMAND_ACCESS).toMatchObject({
      'pairing.create': 'admin',
      'pairing.list': 'admin',
      'pairing.revoke': 'admin',
      'pairing.redeem': 'read',
    })
  })

  it('validate a create request', () => {
    const create = PairingCommandSchemas['pairing.create']
    const envelope = (payload: unknown) => ({
      type: 'command',
      requestId: 'r1',
      name: 'pairing.create',
      payload,
    })
    expect(create.safeParse(envelope({ capabilities: ['read'] })).success).toBe(true)
    expect(create.safeParse(envelope({ capabilities: ['read'], label: null })).success).toBe(true)
    expect(create.safeParse(envelope({ capabilities: ['operate'] })).success).toBe(false)
    expect(create.safeParse(envelope({ capabilities: ['read'], label: '' })).success).toBe(false)
    expect(create.safeParse(envelope({ capabilities: ['read'], extra: 1 })).success).toBe(false)
  })

  it('normalize the exchange token and trim the label', () => {
    expect(
      PairingExchangeRequestSchema.parse({ token: 'abcd-efgh-jkmn', label: '  Phone ' }),
    ).toEqual({ token: 'ABCDEFGHJKMN', label: 'Phone' })
    expect(PairingExchangeRequestSchema.safeParse({ token: 'nope' }).success).toBe(false)
    // The exchange never carries a credential: the route came from a link.
    expect(
      PairingExchangeRequestSchema.safeParse({ token: 'ABCDEFGHJKMN', credential: 'omc1.x' })
        .success,
    ).toBe(false)
  })

  it('refuse control and format characters in labels', () => {
    expect(ClientLabelSchema.safeParse('Phone\u0007').success).toBe(false)
    expect(ClientLabelSchema.safeParse('Phone‮enod').success).toBe(false)
    expect(ClientLabelSchema.safeParse('Lap‍top').success).toBe(false)
    expect(ClientLabelSchema.safeParse('Pixel 9 — Chrome').success).toBe(true)
    expect(ClientLabelSchema.safeParse('x'.repeat(129)).success).toBe(false)
  })
})
