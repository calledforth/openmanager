import type { PairingRejectionReason } from '@openmanager/protocol'
import { pairingRejectionMessage } from '@openmanager/environment-client/connection'

import { endpointHost } from '../environment/connected-route'

/**
 * Why pairing did not finish. Each kind is something that actually happened:
 *
 * - `link`: what was scanned or pasted is not a pairing link this app reads
 *   (the shared parser's own answer).
 * - `rejected`: the environment refused the token, with the reason it gave
 *   (`PAIRING_REJECTION_REASONS`): expired, used, withdrawn (`invalid`), a
 *   creator that lost access (`creator_revoked`), and the rest.
 * - `unreachable`: nothing answered at the link's address.
 * - `timed_out`: the address took the request but did not finish answering
 *   in time. The link may or may not have been used by then.
 * - `environment_mismatch`: the address answered as a different environment
 *   than the link names, so nothing was saved or sent there.
 * - `rate_limited`, `not_pairing`: the address answered, but with HTTP 429, or
 *   with 404/405 (it does not pair devices).
 * - `not_connected`: the phone already holds a token for the environment, so
 *   the link is redeemed over the phone's own connection to it, and that
 *   connection did not come up.
 * - `unexpected`: anything else, with what was said.
 */
export type PairingFailure =
  | { kind: 'link'; problem: 'not_a_link' | 'unsupported_version' | 'malformed' }
  | { kind: 'rejected'; reason: PairingRejectionReason }
  | { kind: 'unreachable'; route: string }
  | { kind: 'timed_out'; route: string }
  | { kind: 'environment_mismatch'; route: string }
  | { kind: 'rate_limited' }
  | { kind: 'not_pairing'; route: string }
  | { kind: 'not_connected'; label: string }
  | { kind: 'unexpected'; detail: string }

/**
 * What the person can do next:
 *
 * - `new_link`: this link cannot work again; make a new one on the computer
 *   and scan or paste it. Clears the link.
 * - `retry`: the same link may still work (nothing used it); try it again.
 * - `close`: nothing on this phone fixes it now (update the app or the
 *   environment); leave the pairing screen.
 */
export type PairingNextAction = 'new_link' | 'retry' | 'close'

export type PairingFailureCopy = {
  title: string
  body: string
  next: PairingNextAction
  /** The words on the next-action button. */
  nextLabel: string
}

const NEXT_LABELS: Record<PairingNextAction, string> = {
  new_link: 'Use a new link',
  retry: 'Try again',
  close: 'Close',
}

const REJECTION_TITLES: Record<PairingRejectionReason, string> = {
  malformed: 'The environment could not read this',
  invalid: 'This link no longer works',
  expired: 'This link expired',
  used: 'This link was already used',
  creator_revoked: 'This link was voided',
  grant_exceeds_link: 'This link offers less access',
  already_authorized: 'Already has full access',
}

/**
 * What a refusal leaves to do. Every reason that uses the link up or says it
 * is gone needs a new one; `malformed` is this app's request going wrong, so
 * the same link is worth another try; `already_authorized` means there is
 * nothing to add.
 */
const REJECTION_NEXT: Record<PairingRejectionReason, PairingNextAction> = {
  malformed: 'retry',
  invalid: 'new_link',
  expired: 'new_link',
  used: 'new_link',
  creator_revoked: 'new_link',
  grant_exceeds_link: 'new_link',
  already_authorized: 'close',
}

const copy = (title: string, body: string, next: PairingNextAction): PairingFailureCopy => ({
  title,
  body,
  next,
  nextLabel: NEXT_LABELS[next],
})

/**
 * The words a failure is shown in, and the next step. The environment's own
 * refusals read as the shared messages web shows (`pairingRejectionMessage`);
 * only the title and the next step are the phone's.
 */
export function describePairingFailure(failure: PairingFailure): PairingFailureCopy {
  switch (failure.kind) {
    case 'link':
      if (failure.problem === 'unsupported_version') {
        return copy(
          'Made by a newer OpenManager',
          'This link comes from a newer version of OpenManager. Update this app, then scan it again.',
          'close',
        )
      }
      if (failure.problem === 'malformed') {
        return copy(
          'Part of this link is missing',
          'Copy the whole link again, or scan the QR code instead.',
          'new_link',
        )
      }
      return copy(
        'Not a pairing link',
        'On your computer, open Settings, then Devices, and choose Pair a device. Scan the QR code it shows, or copy its link.',
        'new_link',
      )
    case 'rejected':
      return copy(
        REJECTION_TITLES[failure.reason],
        pairingRejectionMessage(failure.reason),
        REJECTION_NEXT[failure.reason],
      )
    case 'unreachable':
      return copy(
        'Could not reach your computer',
        `Nothing answered at ${endpointHost(failure.route)}. Check that this phone is on the same network as the computer, or that its tunnel is running. The link has not been used.`,
        'retry',
      )
    case 'timed_out':
      return copy(
        'Your computer did not finish answering',
        `${endpointHost(failure.route)} took the request but did not answer in time. Check the connection and try again; if it then says the link was already used, make a new one.`,
        'retry',
      )
    case 'environment_mismatch':
      return copy(
        'A different environment answered',
        `The address in this link, ${endpointHost(failure.route)}, answered as another environment than the link names, so nothing was saved. Make a new link on the computer you want to pair with.`,
        'new_link',
      )
    case 'rate_limited':
      return copy(
        'Too many attempts',
        'Too many pairing attempts. Wait a minute and try again.',
        'retry',
      )
    case 'not_pairing':
      return copy(
        "That address doesn't pair devices",
        `${endpointHost(failure.route)} does not pair devices. The environment may need updating.`,
        'close',
      )
    case 'not_connected':
      return copy(
        `Could not connect to ${failure.label}`,
        `This phone is already paired with ${failure.label}, so the link is used over that connection, and it did not come up. The link has not been used.`,
        'retry',
      )
    case 'unexpected':
      return copy('Pairing did not finish', failure.detail, 'retry')
  }
}
