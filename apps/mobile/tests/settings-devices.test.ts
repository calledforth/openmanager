import { afterEach, describe, expect, it } from 'vitest'
import {
  createMockEnvironmentClient,
  parsePairingLink,
  type AuthorizedClient,
  type MockEnvironmentClient,
  type PairingLink,
} from '@openmanager/environment-client'
import { PAIRING_LINK_LIFETIME_MS, type AccessCapability } from '@openmanager/protocol'

import {
  EXPIRY_CHECK_DELAY_MS,
  EXPIRY_RECHECK_MS,
  EXPIRY_RECHECKS,
  createDeviceAdmin,
  forgetMadeLinks,
  type DeviceAdmin,
} from '../src/settings/device-admin'
import {
  accessWords,
  confirmCopy,
  expiryWords,
  defaultPairingRoute,
  deviceRows,
  grantWarnings,
  offeredPresets,
  omittedNote,
  pairingGrant,
  presenceWords,
  revocableOthers,
  waitingLinkRows,
} from '../src/settings/devices'

const NOW = Date.parse('2026-10-22T12:00:00.000Z')
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()
const FULL = ['read', 'operate', 'agent', 'terminal', 'admin'] as const
const LATER = new Date(NOW + 30 * 86_400_000).toISOString()

const device = (patch: Partial<AuthorizedClient> & Pick<AuthorizedClient, 'clientId' | 'label'>) =>
  ({
    kind: 'paired',
    capabilities: ['read', 'operate'],
    createdAt: iso(86_400_000),
    lastSeenAt: iso(2 * 3_600_000),
    expiresAt: LATER,
    connected: false,
    ...patch,
  }) satisfies AuthorizedClient

const OWNER = device({
  clientId: 'client-owner',
  label: 'Desktop app',
  kind: 'owner',
  capabilities: [...FULL],
  connected: true,
})
const PHONE = device({
  clientId: 'client-phone',
  label: 'Pixel 9',
  capabilities: [...FULL],
  connected: true,
})
const LAPTOP = device({ clientId: 'client-laptop', label: 'Laptop · Zen' })
const TABLET = device({ clientId: 'client-tablet', label: 'Tablet', lastSeenAt: null })

const clients: MockEnvironmentClient[] = []
const admins: DeviceAdmin[] = []
afterEach(() => {
  for (const admin of admins.splice(0)) admin.dispose()
  for (const client of clients.splice(0)) client.dispose()
  forgetMadeLinks()
})

/** The environment's clock, which a test can move. */
let environmentNow = NOW

function phoneClient(
  authorizedClients: readonly AuthorizedClient[] = [OWNER, PHONE, LAPTOP, TABLET],
  currentClientId = PHONE.clientId,
) {
  environmentNow = NOW
  const client = createMockEnvironmentClient({
    seed: { authorizedClients, currentClientId },
    now: () => new Date(environmentNow).toISOString(),
  })
  clients.push(client)
  return client
}

function started(client: MockEnvironmentClient) {
  const admin = createDeviceAdmin(client, client.getState().environment!.environmentId)
  admins.push(admin)
  admin.start()
  return admin
}

const settle = async (rounds = 8) => {
  for (let round = 0; round < rounds; round += 1) await new Promise((done) => setTimeout(done, 0))
}

const calls = (client: MockEnvironmentClient) => client.calls.map((call) => call.command)

describe('the device list', () => {
  it('marks this phone, says when each was last seen, and what each may do', () => {
    const rows = deviceRows(
      { clients: [OWNER, PHONE, LAPTOP, TABLET], currentClientId: PHONE.clientId, omitted: 0 },
      NOW,
      { canKeepCredential: true },
    )
    expect(rows.map((row) => [row.label, row.isCurrent, row.sub])).toEqual([
      ['Desktop app', false, 'Online now · Full access'],
      ['Pixel 9', true, 'Online now · Full access'],
      ['Laptop · Zen', false, 'Last seen 2h ago · View, Edit'],
      ['Tablet', false, 'Never connected · View, Edit'],
    ])
  })

  it('words presence and access the way web does', () => {
    expect(presenceWords(device({ clientId: 'a', label: 'a', lastSeenAt: iso(10_000) }), NOW)).toBe(
      'Last seen just now',
    )
    expect(
      presenceWords(device({ clientId: 'a', label: 'a', lastSeenAt: iso(3 * 86_400_000) }), NOW),
    ).toBe('Last seen 3d ago')
    expect(accessWords(['read'])).toBe('View')
    expect(accessWords([...FULL])).toBe('Full access')
  })

  it('offers only what the environment would accept from this phone', () => {
    const asPaired = deviceRows(
      { clients: [OWNER, PHONE, LAPTOP], currentClientId: PHONE.clientId, omitted: 0 },
      NOW,
      { canKeepCredential: true },
    )
    // Only the owner names the owner; nobody revokes the owner or themselves;
    // only the owner rotates, and only its own credential.
    expect(asPaired.map((row) => [row.canRename, row.canRevoke, row.canRotate])).toEqual([
      [false, false, false],
      [true, false, false],
      [true, true, false],
    ])
    const asOwner = deviceRows(
      { clients: [OWNER, LAPTOP], currentClientId: OWNER.clientId, omitted: 0 },
      NOW,
      { canKeepCredential: true },
    )
    expect(asOwner[0]).toMatchObject({ canRename: true, canRevoke: false, canRotate: true })
    // An owner with nowhere to keep a new credential is not offered rotation.
    const nowhere = deviceRows(
      { clients: [OWNER], currentClientId: OWNER.clientId, omitted: 0 },
      NOW,
      { canKeepCredential: false },
    )
    expect(nowhere[0]!.canRotate).toBe(false)
  })

  it('counts what revoking the others reaches, omitted devices included', () => {
    const list = { clients: [OWNER, PHONE, LAPTOP, TABLET], currentClientId: PHONE.clientId }
    expect(revocableOthers({ ...list, omitted: 0 })).toBe(2)
    expect(revocableOthers({ ...list, omitted: 3 })).toBe(5)
    // This phone among the omitted: it is never revoked by its own command.
    expect(
      revocableOthers({ clients: [OWNER, LAPTOP], currentClientId: PHONE.clientId, omitted: 2 }),
    ).toBe(2)
    expect(omittedNote(2, true)).toBe(
      '2 more devices, the least recently seen, are not shown, this one among them. Revoking all other devices reaches the rest.',
    )
  })

  it('asks before each action in web’s words', () => {
    expect(confirmCopy({ kind: 'revoke', clientId: 'x', label: 'Laptop' }).title).toBe(
      'Revoke Laptop?',
    )
    expect(confirmCopy({ kind: 'revoke_others', count: 1 }).body).toMatch(/^1 device loses access/)
    expect(confirmCopy({ kind: 'rotate' })).toMatchObject({
      title: 'Rotate the owner credential?',
      action: 'Rotate',
    })
  })
})

describe('the device admin over the shared client', () => {
  it('lists on start and holds the environment’s answer', async () => {
    const client = phoneClient()
    const admin = started(client)
    await settle()
    expect(admin.getState()).toMatchObject({ access: 'admin', loadError: null })
    expect(admin.getState().list!.clients.map((item) => item.clientId)).toEqual([
      OWNER.clientId,
      PHONE.clientId,
      LAPTOP.clientId,
      TABLET.clientId,
    ])
    expect(calls(client)).toEqual(['listAuthorizedClients', 'listPairingLinks'])
  })

  it('tells a phone without admin so, and asks nothing else', async () => {
    const client = phoneClient(
      [OWNER, { ...PHONE, capabilities: ['read', 'operate', 'agent'] }],
      PHONE.clientId,
    )
    const admin = started(client)
    await settle()
    expect(admin.getState()).toMatchObject({ access: 'denied', list: null, links: null })
    expect(calls(client)).toEqual(['listAuthorizedClients'])
  })

  it('follows the environment’s pushes: another device pairing shows up live', async () => {
    const client = phoneClient()
    const admin = started(client)
    await settle()
    const seen: number[] = []
    admin.subscribe(() => seen.push(admin.getState().list?.clients.length ?? 0))
    // The owner, elsewhere, makes a link and a new device trades it.
    const { token } = await client.commands.createPairingLink({ capabilities: ['read'] })
    client.pairDevice(token, 'New tablet')
    await settle()
    expect(admin.getState().list!.clients.map((item) => item.label)).toContain('New tablet')
    expect(seen).toContain(5)
  })

  it('renames, then shows the name the environment answers with', async () => {
    const client = phoneClient()
    const admin = started(client)
    await settle()
    expect(await admin.rename(LAPTOP.clientId, '  Work laptop  ')).toBe(true)
    await settle()
    const renamed = admin.getState().list!.clients.find((item) => item.clientId === LAPTOP.clientId)
    expect(renamed!.label).toBe('Work laptop')
    expect(client.calls.find((call) => call.command === 'renameAuthorizedClient')!.input).toEqual({
      clientId: LAPTOP.clientId,
      label: 'Work laptop',
    })
  })

  it('refuses a blank name without asking the environment', async () => {
    const client = phoneClient()
    const admin = started(client)
    await settle()
    expect(await admin.rename(LAPTOP.clientId, '   ')).toBe(false)
    expect(admin.getState().actionError).toBeTruthy()
    expect(calls(client)).not.toContain('renameAuthorizedClient')
  })

  it('revokes one device and the list is the environment’s again', async () => {
    const client = phoneClient()
    const admin = started(client)
    await settle()
    expect(await admin.revoke(LAPTOP.clientId)).toBe(true)
    await settle()
    expect(admin.getState().list!.clients.map((item) => item.clientId)).not.toContain(
      LAPTOP.clientId,
    )
    // Read again after the answer, never edited in place.
    expect(calls(client).filter((name) => name === 'listAuthorizedClients').length).toBe(2)
  })

  it('shows the environment’s refusal and keeps the list as it was', async () => {
    const client = phoneClient()
    const admin = started(client)
    await settle()
    expect(await admin.revoke(OWNER.clientId)).toBe(false)
    expect(admin.getState().actionError).toBe('The owner cannot be revoked.')
    expect(admin.getState().list!.clients).toHaveLength(4)
  })

  it('revokes every other device but this phone and the owner', async () => {
    const client = phoneClient()
    const admin = started(client)
    await settle()
    expect(await admin.revokeOthers()).toBe(true)
    await settle()
    expect(admin.getState().list!.clients.map((item) => item.clientId)).toEqual([
      OWNER.clientId,
      PHONE.clientId,
    ])
  })

  it('rotates only as the owner, handing the new credential back once', async () => {
    const asPhone = started(phoneClient())
    await settle()
    expect(await asPhone.rotate()).toBeNull()
    expect(asPhone.getState().actionError).toMatch(/Only the owner/)

    const ownerClient = phoneClient([OWNER, LAPTOP], OWNER.clientId)
    const asOwner = started(ownerClient)
    await settle()
    const credential = await asOwner.rotate()
    expect(credential).toMatch(/^omc1\./)
    // Never kept in the state the screen reads.
    expect(JSON.stringify(asOwner.getState())).not.toContain(credential!)
  })

  it('lists again on every reconnect', async () => {
    const client = phoneClient()
    const admin = started(client)
    await settle()
    client.setConnection({ phase: 'reconnecting' })
    client.setConnection({ phase: 'connected' })
    await settle()
    expect(calls(client).filter((name) => name === 'listAuthorizedClients').length).toBe(2)
    expect(admin.getState().access).toBe('admin')
  })

  it('stops listening once stopped', async () => {
    const client = phoneClient()
    const admin = createDeviceAdmin(client, 'env')
    admins.push(admin)
    const stop = admin.start()
    await settle()
    stop()
    const { token } = await client.commands.createPairingLink({ capabilities: ['read'] })
    client.pairDevice(token, 'Late')
    await settle()
    expect(admin.getState().list!.clients.map((item) => item.label)).not.toContain('Late')
  })
})

/** A clock and timers the test drives by hand. */
function manualClock(start = NOW) {
  let now = start
  const timers: Array<{ at: number; fn: () => void; handle: number }> = []
  let next = 0
  return {
    clock: {
      now: () => now,
      setTimeout: (fn: () => void, ms: number) => {
        const handle = ++next
        timers.push({ at: now + ms, fn, handle })
        return handle
      },
      clearTimeout: (handle: unknown) => {
        const index = timers.findIndex((timer) => timer.handle === handle)
        if (index >= 0) timers.splice(index, 1)
      },
    },
    pending: () => timers.length,
    advance(ms: number) {
      now += ms
      for (const timer of [...timers].sort((a, b) => a.at - b.at)) {
        if (timer.at > now) continue
        timers.splice(timers.indexOf(timer), 1)
        timer.fn()
      }
    },
  }
}

describe('pairing link expiry', () => {
  const LINK = {
    capabilities: ['read'] as AccessCapability[],
    route: 'http://192.168.1.4:43120',
    appUrl: 'https://app.example.test',
  }

  it('keeps a link the environment still lists as waiting, whatever this phone’s clock says', () => {
    const link = {
      linkId: 'l1',
      label: null,
      capabilities: ['read'],
      createdByClientId: PHONE.clientId,
      createdAt: iso(10 * 60_000),
      expiresAt: iso(5 * 60_000),
      status: 'waiting',
      usedByClientId: null,
      usedAt: null,
    } satisfies PairingLink
    const context = {
      currentClientId: PHONE.clientId,
      deviceLabel: () => undefined,
      madeHere: () => true,
    }
    expect(waitingLinkRows([link], NOW, { ...context, connected: true })[0]!.sub).toBe(
      'View · checking with the environment…',
    )
    expect(waitingLinkRows([link], NOW, { ...context, connected: false })[0]!.sub).toBe(
      "View · can't confirm while offline",
    )
    expect(expiryWords(link, NOW - 6 * 60_000, true)).toBe('expires in 1:00')
  })

  it('asks the environment again when a link reaches its time, and shows its answer', async () => {
    const client = phoneClient()
    const manual = manualClock()
    const admin = createDeviceAdmin(client, 'env', manual.clock)
    admins.push(admin)
    admin.start()
    await settle()
    const shown = await admin.createLink(LINK)
    await settle()
    const reads = () => calls(client).filter((name) => name === 'listPairingLinks').length
    const before = reads()
    // Five minutes on: the countdown is done, and the environment is asked.
    environmentNow = NOW + PAIRING_LINK_LIFETIME_MS + 1000
    manual.advance(PAIRING_LINK_LIFETIME_MS + EXPIRY_CHECK_DELAY_MS)
    await settle()
    expect(reads()).toBe(before + 1)
    const link = admin.getState().links!.find((item) => item.linkId === shown!.link.linkId)!
    expect(link.status).toBe('expired')
    expect(manual.pending()).toBe(0)
  })

  it('asks a few more times while the environment disagrees, then leaves it', async () => {
    const client = phoneClient()
    const manual = manualClock()
    const admin = createDeviceAdmin(client, 'env', manual.clock)
    admins.push(admin)
    admin.start()
    await settle()
    await admin.createLink(LINK)
    await settle()
    const reads = () => calls(client).filter((name) => name === 'listPairingLinks').length
    const before = reads()
    // This phone's clock runs ahead; the environment's does not.
    manual.advance(PAIRING_LINK_LIFETIME_MS + EXPIRY_CHECK_DELAY_MS)
    await settle()
    for (let round = 0; round < EXPIRY_RECHECKS + 2; round += 1) {
      manual.advance(EXPIRY_RECHECK_MS)
      await settle()
    }
    // At its time, then again until the limit: EXPIRY_RECHECKS asks in all.
    expect(reads()).toBe(before + EXPIRY_RECHECKS)
    expect(admin.getState().links![0]!.status).toBe('waiting')
    expect(manual.pending()).toBe(0)
  })

  it('does not ask while offline, and asks again on the reconnect', async () => {
    const client = phoneClient()
    const manual = manualClock()
    const admin = createDeviceAdmin(client, 'env', manual.clock)
    admins.push(admin)
    admin.start()
    await settle()
    await admin.createLink(LINK)
    await settle()
    client.setConnection({ phase: 'reconnecting' })
    expect(admin.getState().connected).toBe(false)
    expect(manual.pending()).toBe(0)
    environmentNow = NOW + PAIRING_LINK_LIFETIME_MS + 1000
    manual.advance(PAIRING_LINK_LIFETIME_MS + EXPIRY_CHECK_DELAY_MS)
    // Still the last report: waiting.
    expect(admin.getState().links![0]!.status).toBe('waiting')
    client.setConnection({ phase: 'connected' })
    await settle()
    expect(admin.getState().links![0]!.status).toBe('expired')
  })
})

describe('pairing links', () => {
  const ROUTES = [
    { type: 'lan', endpoint: 'http://127.0.0.1:43120', priority: 0 },
    { type: 'lan', endpoint: 'http://192.168.1.4:43120', priority: 1 },
  ] as never

  it('makes a link for the route another device can reach, and shows it as a QR-ready URL', async () => {
    const client = phoneClient()
    const admin = started(client)
    await settle()
    const environmentId = client.getState().environment!.environmentId
    const route = defaultPairingRoute(ROUTES, 'http://127.0.0.1:43120')
    expect(route).toBe('http://192.168.1.4:43120')
    const shown = await admin.createLink({
      capabilities: pairingGrant('full', false, PHONE.capabilities),
      route: route!,
      appUrl: 'https://app.example.test',
    })
    expect(shown).not.toBeNull()
    const parsed = parsePairingLink(shown!.url)
    expect(parsed).toMatchObject({ ok: true, payload: { route, environmentId } })
    expect(shown!.url.startsWith('https://app.example.test/pair#')).toBe(true)
    expect(admin.madeLink(shown!.link.linkId)).toBe(shown!.url)
    await settle()
    expect(admin.getState().links!.map((link) => link.linkId)).toEqual([shown!.link.linkId])
  })

  it('lists waiting links newest first, with where each was made', async () => {
    const client = phoneClient()
    const admin = started(client)
    await settle()
    const mine = await admin.createLink({
      capabilities: ['read'],
      route: 'http://192.168.1.4:43120',
      appUrl: 'https://app.example.test',
    })
    await settle()
    const rows = waitingLinkRows(admin.getState().links!, NOW + 60_000, {
      connected: true,
      currentClientId: PHONE.clientId,
      deviceLabel: () => undefined,
      madeHere: (linkId) => admin.madeLink(linkId) !== undefined,
    })
    expect(rows).toEqual([
      {
        linkId: mine!.link.linkId,
        title: 'New device',
        sub: 'View · expires in 4:00',
        shownHere: true,
      },
    ])
    const elsewhere = waitingLinkRows(admin.getState().links!, NOW, {
      connected: true,
      currentClientId: 'someone-else',
      deviceLabel: (clientId) => (clientId === PHONE.clientId ? 'Pixel 9' : undefined),
      madeHere: () => false,
    })
    expect(elsewhere[0]!.sub).toBe('View · expires in 5:00 · Made on Pixel 9')
  })

  it('withdraws a link; the environment’s list then says it stopped', async () => {
    const client = phoneClient()
    const admin = started(client)
    await settle()
    const shown = await admin.createLink({
      capabilities: ['read'],
      route: 'http://192.168.1.4:43120',
      appUrl: 'https://app.example.test',
    })
    expect(await admin.revokeLink(shown!.link.linkId)).toBe(true)
    await settle()
    expect(admin.getState().links!.find((link) => link.linkId === shown!.link.linkId)!.status).toBe(
      'revoked',
    )
    expect(admin.madeLink(shown!.link.linkId)).toBeUndefined()
  })

  it('learns a link was used when the device it paired appears', async () => {
    const client = phoneClient()
    const admin = started(client)
    await settle()
    const shown = await admin.createLink({
      capabilities: ['read'],
      route: 'http://192.168.1.4:43120',
      appUrl: 'https://app.example.test',
    })
    const parsed = parsePairingLink(shown!.url)
    if (!parsed.ok) throw new Error('unreadable link')
    client.pairDevice(parsed.payload.token, 'Their phone')
    await settle()
    const link = admin.getState().links!.find((item) => item.linkId === shown!.link.linkId)!
    expect(link.status).toBe('used')
    expect(admin.madeLink(link.linkId)).toBeUndefined()
  })

  it('offers no more access than this phone holds, with web’s cautions', () => {
    expect(pairingGrant('full', true, ['read', 'operate'])).toEqual(['read', 'operate'])
    expect(pairingGrant('full', true, [...FULL])).toEqual([...FULL])
    expect(pairingGrant('view', false, [...FULL])).toEqual(['read'])
    expect(offeredPresets(['read', 'operate']).map((preset) => preset.id)).toEqual(['view'])
    expect(grantWarnings(['read', 'agent', 'admin'])).toHaveLength(2)
    expect(grantWarnings(['read'])).toEqual([])
  })
})
