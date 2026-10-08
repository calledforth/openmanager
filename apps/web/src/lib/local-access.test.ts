import { describe, expect, it } from 'vitest'
import { loopbackAccessDenied } from './local-access'

function permissions(states: Record<string, string>) {
  const asked: string[] = []
  return {
    asked,
    query: async ({ name }: { name: string }) => {
      asked.push(name)
      const state = states[name]
      if (state === undefined) throw new TypeError(`Unknown permission ${name}`)
      return { state }
    },
  }
}

describe('loopbackAccessDenied', () => {
  it('reads the loopback permission', async () => {
    const denied = permissions({ 'loopback-network': 'denied' })
    await expect(loopbackAccessDenied(denied)).resolves.toBe(true)
    expect(denied.asked).toEqual(['loopback-network'])
    await expect(
      loopbackAccessDenied(permissions({ 'loopback-network': 'granted' })),
    ).resolves.toBe(false)
    await expect(loopbackAccessDenied(permissions({ 'loopback-network': 'prompt' }))).resolves.toBe(
      false,
    )
  })

  it('never asks for the legacy combined permission, which crashes older Chrome', async () => {
    const older = permissions({ 'local-network-access': 'denied' })
    await expect(loopbackAccessDenied(older)).resolves.toBe(false)
    expect(older.asked).toEqual(['loopback-network'])
  })

  it('reports nothing denied where the browser has no such permission', async () => {
    await expect(loopbackAccessDenied(permissions({}))).resolves.toBe(false)
    await expect(loopbackAccessDenied(undefined)).resolves.toBe(false)
  })
})
