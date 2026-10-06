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
  it('reads the current permission name first', async () => {
    // Edge 154 answers both names, and only the current one carries the denial.
    const both = permissions({ 'loopback-network': 'denied', 'local-network-access': 'prompt' })
    await expect(loopbackAccessDenied(both)).resolves.toBe(true)
    expect(both.asked).toEqual(['loopback-network'])
    await expect(
      loopbackAccessDenied(permissions({ 'loopback-network': 'granted' })),
    ).resolves.toBe(false)
    await expect(loopbackAccessDenied(permissions({ 'loopback-network': 'prompt' }))).resolves.toBe(
      false,
    )
  })

  it('falls back to the name the first Chrome versions used', async () => {
    const older = permissions({ 'local-network-access': 'denied' })
    await expect(loopbackAccessDenied(older)).resolves.toBe(true)
    expect(older.asked).toEqual(['loopback-network', 'local-network-access'])
  })

  it('reports nothing denied where the browser has no such permission', async () => {
    await expect(loopbackAccessDenied(permissions({}))).resolves.toBe(false)
    await expect(loopbackAccessDenied(undefined)).resolves.toBe(false)
  })
})
