import { describe, expect, it } from 'vitest'
import { PAIRING_REJECTION_REASONS } from '@openmanager/protocol'
import { pairingRejectionMessage } from '@openmanager/environment-client/connection'
import { describePairingFailure, type PairingFailure } from '../src/pairing/failures'

describe('what a pairing failure says, and what it offers next', () => {
  it("words every reason the environment reports with web's shared message", () => {
    for (const reason of PAIRING_REJECTION_REASONS) {
      const words = describePairingFailure({ kind: 'rejected', reason })
      expect(words.body).toBe(pairingRejectionMessage(reason))
      expect(words.title).not.toBe('')
      expect(words.nextLabel).not.toBe('')
    }
  })

  it('asks for a new link when the link is used up or gone', () => {
    for (const reason of ['expired', 'used', 'invalid', 'creator_revoked'] as const) {
      expect(describePairingFailure({ kind: 'rejected', reason })).toMatchObject({
        next: 'new_link',
        nextLabel: 'Use a new link',
      })
    }
    expect(describePairingFailure({ kind: 'rejected', reason: 'expired' }).title).toBe(
      'This link expired',
    )
    expect(describePairingFailure({ kind: 'rejected', reason: 'used' }).title).toBe(
      'This link was already used',
    )
    expect(describePairingFailure({ kind: 'rejected', reason: 'invalid' }).body).toMatch(
      /withdrawn/,
    )
    expect(describePairingFailure({ kind: 'rejected', reason: 'creator_revoked' }).body).toMatch(
      /no longer has access/,
    )
  })

  it('offers the same link again when nothing used it', () => {
    const cases: PairingFailure[] = [
      { kind: 'unreachable', route: 'http://192.168.1.4:43120' },
      { kind: 'rate_limited' },
      { kind: 'timed_out', route: 'http://192.168.1.4:43120' },
      { kind: 'not_connected', label: 'Studio' },
      { kind: 'unexpected', detail: 'The environment answered with HTTP 500.' },
      { kind: 'rejected', reason: 'malformed' },
    ]
    for (const failure of cases) {
      expect(describePairingFailure(failure)).toMatchObject({
        next: 'retry',
        nextLabel: 'Try again',
      })
    }
    expect(
      describePairingFailure({ kind: 'unreachable', route: 'http://192.168.1.4:43120' }).body,
    ).toContain('192.168.1.4:43120')
  })

  it('names the address that answered as another environment, and asks for a new link', () => {
    const words = describePairingFailure({
      kind: 'environment_mismatch',
      route: 'https://studio.example.com',
    })
    expect(words).toMatchObject({ title: 'A different environment answered', next: 'new_link' })
    expect(words.body).toContain('studio.example.com')
    expect(words.body).toMatch(/nothing was saved/)
  })

  it('closes when only an update helps', () => {
    expect(describePairingFailure({ kind: 'link', problem: 'unsupported_version' })).toMatchObject({
      next: 'close',
      nextLabel: 'Close',
    })
    expect(
      describePairingFailure({ kind: 'not_pairing', route: 'https://studio.example.com' }),
    ).toMatchObject({ next: 'close' })
    expect(
      describePairingFailure({ kind: 'rejected', reason: 'already_authorized' }),
    ).toMatchObject({ next: 'close' })
  })

  it('asks for the whole link again when what was read is not one', () => {
    for (const problem of ['not_a_link', 'malformed'] as const) {
      expect(describePairingFailure({ kind: 'link', problem })).toMatchObject({ next: 'new_link' })
    }
  })

  it('never says browser on the phone', () => {
    for (const reason of PAIRING_REJECTION_REASONS) {
      expect(describePairingFailure({ kind: 'rejected', reason }).body).not.toMatch(/browser/i)
    }
  })
})
