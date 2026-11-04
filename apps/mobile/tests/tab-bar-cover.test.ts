import { describe, expect, it, vi } from 'vitest'

import { createTabBarCover } from '../src/ui/tab-bar-cover'

describe('tab bar cover', () => {
  it('covers the pill while any sheet is open, and says so once each way', () => {
    const cover = createTabBarCover()
    const heard = vi.fn()
    cover.subscribe(heard)
    expect(cover.covered()).toBe(false)

    const first = cover.raise()
    const second = cover.raise()
    expect(cover.covered()).toBe(true)
    expect(heard).toHaveBeenCalledTimes(1)

    first()
    expect(cover.covered()).toBe(true)
    second()
    expect(cover.covered()).toBe(false)
    expect(heard).toHaveBeenCalledTimes(2)
  })

  it('lowers once per sheet, however often its close runs', () => {
    const cover = createTabBarCover()
    const lower = cover.raise()
    const other = cover.raise()
    lower()
    lower()
    expect(cover.covered()).toBe(true)
    other()
    expect(cover.covered()).toBe(false)
  })
})
