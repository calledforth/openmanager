import { describe, expect, it } from 'vitest'
import { serverUpdateNotice, type ServerUpdateWatchSnapshot } from '@openmanager/environment-client'

import { serverUpdateRowView, showsServerUpdateCard } from '../src/server-update/view'

const snapshot = (
  status: Partial<NonNullable<ServerUpdateWatchSnapshot['status']>> | undefined,
  extra: Partial<ServerUpdateWatchSnapshot> = {},
): ServerUpdateWatchSnapshot => ({
  status: status
    ? {
        currentVersion: '0.21.0',
        latestVersion: '0.22.0',
        updateAvailable: true,
        checkedAt: null,
        canUpdate: true,
        state: 'idle',
        ...status,
      }
    : undefined,
  unsupported: false,
  starting: false,
  error: undefined,
  justUpdated: undefined,
  ...extra,
})

const view = (value: ServerUpdateWatchSnapshot) =>
  serverUpdateRowView(serverUpdateNotice(value), value)

describe('server update row', () => {
  it('offers the update, and says it restarts by itself', () => {
    expect(view(snapshot({}))).toEqual({
      title: 'Update server to 0.22.0',
      sub: 'On 0.21.0 · it restarts by itself',
      action: 'update',
      tone: 'ok',
    })
  })

  it('follows the update and says when it finished', () => {
    expect(view(snapshot({ state: 'updating', targetVersion: '0.22.0' }))).toMatchObject({
      title: 'Updating server to 0.22.0',
      action: null,
      tone: 'working',
    })
    expect(
      view(
        snapshot({ currentVersion: '0.22.0' }, { justUpdated: { from: '0.21.0', to: '0.22.0' } }),
      ),
    ).toMatchObject({ title: 'Server updated to 0.22.0', sub: 'From 0.21.0' })
  })

  it('says what to run for a server that cannot update itself, or is too old to ask', () => {
    expect(
      view(snapshot({ canUpdate: false, cannotUpdateReason: 'From a checkout.' })),
    ).toMatchObject({ title: 'Server 0.22.0 is out', sub: 'From a checkout.', action: null })
    expect(view(snapshot(undefined, { unsupported: true }))).toMatchObject({
      title: 'Server too old to update from here',
      action: null,
    })
  })

  it('shows the version, up to date, with a check', () => {
    expect(view(snapshot({ latestVersion: '0.21.0', updateAvailable: false }))).toEqual({
      title: 'Server 0.21.0',
      sub: 'Up to date · Tap to check again',
      action: 'check',
      tone: 'idle',
    })
    expect(view(snapshot(undefined))).toBeNull()
  })

  it('keeps a put-away offer off the home until a newer version', () => {
    const offer = serverUpdateNotice(snapshot({}))
    expect(showsServerUpdateCard(offer, undefined)).toBe(true)
    expect(showsServerUpdateCard(offer, '0.22.0')).toBe(false)
    expect(
      showsServerUpdateCard(serverUpdateNotice(snapshot({ latestVersion: '0.23.0' })), '0.22.0'),
    ).toBe(true)
    expect(
      showsServerUpdateCard(
        serverUpdateNotice(snapshot({ latestVersion: '0.21.0', updateAvailable: false })),
        undefined,
      ),
    ).toBe(false)
  })
})

describe('after an update', () => {
  it('says which version the server replaced, even to a phone that was away', () => {
    expect(
      view(
        snapshot({
          currentVersion: '0.22.0',
          latestVersion: null,
          updateAvailable: false,
          updatedFrom: '0.21.0',
        }),
      ),
    ).toMatchObject({ title: 'Server 0.22.0', sub: 'Updated from 0.21.0 · Tap to check again' })
  })
})
