import { describe, expect, it } from 'vitest'
import { updateProgressPercent } from './app-update'

describe('update progress', () => {
  it('starts an available update at zero until download progress arrives', () => {
    expect(updateProgressPercent({ status: 'available', version: '2.0.0' })).toBe(0)
  })

  it('rounds and clamps download progress', () => {
    expect(
      updateProgressPercent({
        status: 'downloading',
        version: '2.0.0',
        percent: 47.6,
        bytesPerSecond: 1,
        transferred: 1,
        total: 2,
      }),
    ).toBe(48)
    expect(
      updateProgressPercent({
        status: 'downloading',
        version: '2.0.0',
        percent: 150,
        bytesPerSecond: 1,
        transferred: 2,
        total: 2,
      }),
    ).toBe(100)
  })

  it('marks a downloaded update complete', () => {
    expect(updateProgressPercent({ status: 'ready', version: '2.0.0' })).toBe(100)
  })
})
