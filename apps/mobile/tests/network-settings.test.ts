import { describe, expect, it } from 'vitest'

import {
  ANDROID_WIRELESS_SETTINGS,
  openNetworkSettings,
  type SettingsLinking,
} from '../src/environment/network-settings'

/** A `Linking` whose two calls succeed or fail as told, recording what was asked. */
function linking(intent: 'ok' | 'fails', settings: 'ok' | 'fails') {
  const calls: string[] = []
  const fake: SettingsLinking = {
    sendIntent: async (action) => {
      calls.push(`intent:${action}`)
      if (intent === 'fails') throw new Error('No Activity found to handle Intent')
    },
    openSettings: async () => {
      calls.push('settings')
      if (settings === 'fails') throw new Error('Unable to open settings')
    },
  }
  return { fake, calls }
}

describe('opening the network settings for the offline state', () => {
  it('Android: the wireless settings, and nothing else when they open', async () => {
    const { fake, calls } = linking('ok', 'ok')
    expect(await openNetworkSettings('android', fake)).toBe(true)
    expect(calls).toEqual([`intent:${ANDROID_WIRELESS_SETTINGS}`])
  })

  it("Android: the app's settings when the wireless screen is missing", async () => {
    const { fake, calls } = linking('fails', 'ok')
    expect(await openNetworkSettings('android', fake)).toBe(true)
    expect(calls).toEqual([`intent:${ANDROID_WIRELESS_SETTINGS}`, 'settings'])
  })

  it('Android: both fail, and the failure is reported, never thrown', async () => {
    const { fake, calls } = linking('fails', 'fails')
    await expect(openNetworkSettings('android', fake)).resolves.toBe(false)
    expect(calls).toEqual([`intent:${ANDROID_WIRELESS_SETTINGS}`, 'settings'])
  })

  it("iOS: the app's settings, its only door", async () => {
    const { fake, calls } = linking('ok', 'ok')
    expect(await openNetworkSettings('ios', fake)).toBe(true)
    expect(calls).toEqual(['settings'])
  })

  it('iOS: the settings refuse, and the failure is reported, never thrown', async () => {
    const { fake, calls } = linking('ok', 'fails')
    await expect(openNetworkSettings('ios', fake)).resolves.toBe(false)
    expect(calls).toEqual(['settings'])
  })
})
