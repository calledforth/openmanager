import type { EnvironmentClient } from '@openmanager/environment-client'
import {
  exchangePairingToken,
  pairingRejectionReason,
} from '@openmanager/environment-client/connection'

import type { PhoneConnectionController } from '../environment/controller'
import type { PairingFailure } from './failures'
import type { PairingLinkRead } from './link'

/** What pairing needs of the connection controller. */
export type PairingController = Pick<
  PhoneConnectionController,
  | 'getState'
  | 'subscribe'
  | 'saveEnvironment'
  | 'selectEnvironment'
  | 'classifyRoute'
  | 'checkRoute'
  | 'addRoute'
  | 'retry'
>

/**
 * What to do with a link, decided before anything is sent anywhere.
 *
 * - `exchange`: the phone holds no token for the link's environment (never
 *   paired, or its token was refused or unreadable). The link's token is
 *   traded for one at `POST {route}/pair`.
 * - `redeem`: the phone holds a token. The link is redeemed over the phone's
 *   own connection (`pairing.redeem`), so its token never goes to an
 *   address a link named.
 * - `consent`: the link names an environment the phone already knows, at an
 *   address new to it. Nothing joins silently: a person agrees first, then
 *   the pairing goes on as `then` says. With a token held, the shared rule
 *   (`sendsSavedCredential`) is why: reaching the address would send the
 *   saved token where it has never been, on the word of a link anyone can
 *   forge. Without one the same question stands, since the answer would be
 *   saved into that environment's record and used on its other routes.
 */
export type PairingPlan =
  | { kind: 'exchange' }
  | { kind: 'redeem'; label: string }
  | {
      kind: 'consent'
      label: string
      route: string
      then: 'exchange' | 'redeem'
      /** Agreeing lets the phone send its saved token to the new address. */
      sendsSavedCredential: boolean
    }

export function planPairing(link: PairingLinkRead, controller: PairingController): PairingPlan {
  const { environmentId, route } = link.payload
  const saved = controller
    .getState()
    .environments.find((environment) => environment.environmentId === environmentId)
  if (!saved) return { kind: 'exchange' }
  const then = saved.paired ? 'redeem' : 'exchange'
  const standing = controller.classifyRoute({ environmentId, endpoint: route })
  if (standing.kind === 'new_route') {
    return {
      kind: 'consent',
      label: saved.label,
      route,
      then,
      sendsSavedCredential: standing.sendsSavedCredential,
    }
  }
  return then === 'redeem' ? { kind: 'redeem', label: saved.label } : { kind: 'exchange' }
}

export type PairingSuccess = {
  environmentId: string
  /** The name the environment lists this phone under on its Devices page. */
  clientLabel: string
  how: 'exchanged' | 'redeemed'
}

export type PairingResult =
  { ok: true; paired: PairingSuccess } | { ok: false; failure: PairingFailure }

const fail = (failure: PairingFailure): PairingResult => ({ ok: false, failure })

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * How long the exchange may take, answer body included. A route that takes
 * the request and never finishes answering reads as one that is unreachable,
 * so the pairing ends and can be tried again.
 */
export const EXCHANGE_TIMEOUT_MS = 20_000

/**
 * Trade the link's token for this phone's own token at the link's route,
 * then save the environment through the controller: the token to
 * SecureStore, the route, label and app origin to the registry. The token
 * goes from the answer straight to the controller; nothing else keeps it.
 *
 * `fetchImpl` is watched only to tell what went wrong when the shared
 * exchange gives no reason: nothing answered, or an HTTP status.
 */
export async function exchangeLink(
  link: PairingLinkRead,
  input: { label?: string },
  controller: PairingController,
  fetchImpl: typeof fetch,
  options: { timeoutMs?: number } = {},
): Promise<PairingResult> {
  const { route, environmentId, token } = link.payload
  // The token is used up by the exchange; with the registry not loaded yet
  // its answer could not be saved, so nothing is sent.
  if (controller.getState().status === 'starting') {
    return fail({
      kind: 'unexpected',
      detail: 'The phone is still loading. Try again in a moment.',
    })
  }
  const deadline = AbortSignal.timeout(options.timeoutMs ?? EXCHANGE_TIMEOUT_MS)
  const seen: { network: boolean; status: number | null } = { network: false, status: null }
  const watched: typeof fetch = async (request, init) => {
    try {
      // A redirect would carry the token somewhere the link did not name.
      const response = await fetchImpl(request, { ...init, signal: deadline, redirect: 'error' })
      seen.status = response.status
      return response
    } catch (error) {
      seen.network = true
      throw error
    }
  }
  let answer: Awaited<ReturnType<typeof exchangePairingToken>>
  try {
    answer = await exchangePairingToken(
      route,
      input.label ? { token, label: input.label } : { token },
      watched,
    )
  } catch (error) {
    const reason = pairingRejectionReason(error)
    if (reason) return fail({ kind: 'rejected', reason })
    if (seen.network) return fail({ kind: 'unreachable', route })
    if (seen.status === 429) return fail({ kind: 'rate_limited' })
    if (seen.status === 404 || seen.status === 405) return fail({ kind: 'not_pairing', route })
    return fail({ kind: 'unexpected', detail: describeError(error) })
  }
  // The link's route answered for another environment than the link names.
  // Its token stays unsaved: nothing says what it opens.
  if (answer.environmentId !== environmentId) {
    return fail({ kind: 'environment_mismatch', route })
  }
  try {
    controller.saveEnvironment({
      environmentId: answer.environmentId,
      endpoint: route,
      label: answer.label,
      credential: answer.credential,
      appOrigin: link.appOrigin,
    })
  } catch (error) {
    return fail({ kind: 'unexpected', detail: describeError(error) })
  }
  // Read back what the controller holds: a save it did not take is not a pairing.
  const saved = controller
    .getState()
    .environments.find((environment) => environment.environmentId === environmentId)
  if (!saved?.paired) {
    return fail({
      kind: 'unexpected',
      detail:
        'The environment answered, but this phone could not save it. Pair again with a new link.',
    })
  }
  return {
    ok: true,
    paired: { environmentId, clientLabel: answer.clientLabel, how: 'exchanged' },
  }
}

/**
 * Before asking whether a new address may join a saved environment: ask the
 * address's `/bootstrap` (no token sent) whether it answers as that
 * environment at all. Only then is there anything to agree to.
 */
export async function checkNewRoute(
  link: PairingLinkRead,
  controller: PairingController,
): Promise<{ ok: true } | { ok: false; failure: PairingFailure }> {
  const { route, environmentId } = link.payload
  const outcome = await controller.checkRoute(route)
  if (outcome.status === 'ready' || outcome.status === 'incompatible_protocol') {
    if (outcome.environmentId === environmentId) return { ok: true }
    return { ok: false, failure: { kind: 'environment_mismatch', route } }
  }
  if (outcome.status === 'unreachable') {
    return { ok: false, failure: { kind: 'unreachable', route } }
  }
  return {
    ok: false,
    failure: {
      kind: 'unexpected',
      detail: `${route} answered, but not as an environment this phone can read.`,
    },
  }
}

/** A person agreed: the link's route joins the saved environment as its last choice. */
export function joinRoute(link: PairingLinkRead, controller: PairingController): boolean {
  return controller.addRoute({
    environmentId: link.payload.environmentId,
    endpoint: link.payload.route,
    appOrigin: link.appOrigin,
  })
}

export const REDEEM_CONNECT_TIMEOUT_MS = 20_000

export type PairingTimers = {
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
}

const realTimers: PairingTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/**
 * The controller's client for `environmentId` once its socket is up, or
 * `null` when the controller stops on a refusal or `timeoutMs` passes.
 */
export function connectedClient(
  controller: PairingController,
  environmentId: string,
  options: { timeoutMs?: number; timers?: PairingTimers } = {},
): Promise<EnvironmentClient | null> {
  const timers = options.timers ?? realTimers
  return new Promise((resolve) => {
    let done = false
    let unsubscribe: (() => void) | null = null
    let timer: unknown = null
    const finish = (client: EnvironmentClient | null) => {
      if (done) return
      done = true
      if (timer !== null) timers.clearTimeout(timer)
      unsubscribe?.()
      resolve(client)
    }
    const read = () => {
      const state = controller.getState()
      if (state.selectedId !== environmentId) return
      if (state.status === 'unauthorized' || state.status === 'incompatible_protocol') {
        finish(null)
        return
      }
      // The controller's client is made for the selected environment only
      // (it refuses a handshake from any other), and goes when the selection
      // changes, so a connected client here is that environment's.
      if (state.status === 'connected' && state.client) finish(state.client)
    }
    unsubscribe = controller.subscribe(read)
    read()
    if (!done) {
      timer = timers.setTimeout(() => finish(null), options.timeoutMs ?? REDEEM_CONNECT_TIMEOUT_MS)
    }
  })
}

/**
 * Redeem the link as the device the phone already is to that environment:
 * over the controller's own socket to it, never at the link's route. The
 * phone keeps its token and name and takes the link's access.
 */
export async function redeemLink(
  link: PairingLinkRead,
  controller: PairingController,
  options: { timeoutMs?: number; timers?: PairingTimers } = {},
): Promise<PairingResult> {
  const { environmentId, token } = link.payload
  const state = controller.getState()
  const label =
    state.environments.find((environment) => environment.environmentId === environmentId)?.label ??
    'this environment'
  if (state.selectedId !== environmentId) controller.selectEnvironment(environmentId)
  else if (
    state.status === 'unauthorized' ||
    state.status === 'incompatible_protocol' ||
    state.status === 'waiting'
  ) {
    // A person asked to use the link: stopped or backing off, the connection
    // is asked again now rather than read as refused from before.
    controller.retry()
  }
  const client = await connectedClient(controller, environmentId, options)
  if (!client) return fail({ kind: 'not_connected', label })
  try {
    const answer = await client.commands.redeemPairingLink({ token })
    return {
      ok: true,
      paired: { environmentId, clientLabel: answer.clientLabel, how: 'redeemed' },
    }
  } catch (error) {
    const reason = pairingRejectionReason(error)
    if (reason) return fail({ kind: 'rejected', reason })
    return fail({ kind: 'unexpected', detail: describeError(error) })
  }
}
