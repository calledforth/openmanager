import { describe, expect, it, vi } from 'vitest'

import { parseFeed, type UpdateRelease } from '../src/updates/feed'
import { createUpdater, type UpdaterPorts } from '../src/updates/updater'
import { showsHomeNotice, updateRowView } from '../src/updates/view'

const RELEASE: UpdateRelease = {
  version: '0.1.14',
  build: 14,
  url: 'https://github.com/calledforth/openmanager/releases/download/mobile-v0.1.14/openmanager-0.1.14.apk',
  size: 61_000_000,
}

function ports(overrides: Partial<UpdaterPorts> = {}): UpdaterPorts {
  return {
    currentBuild: 12,
    fetchFeed: vi.fn(async () => RELEASE),
    download: vi.fn(async () => 'content://apk'),
    install: vi.fn(async () => {}),
    now: () => 0,
    ...overrides,
  }
}

describe('parseFeed', () => {
  it('reads what CI writes', () => {
    expect(parseFeed(RELEASE)).toEqual(RELEASE)
  })

  it.each([
    [null],
    ['nope'],
    [{ ...RELEASE, build: '14' }],
    [{ ...RELEASE, url: 'http://example.test/a.apk' }],
    [{ ...RELEASE, size: 0 }],
    [{ ...RELEASE, version: '' }],
  ])('refuses %j', (raw) => {
    expect(parseFeed(raw)).toBeNull()
  })
})

describe('createUpdater', () => {
  it('offers a newer build, and nothing for the same or an older one', async () => {
    const newer = createUpdater(ports())
    await newer.check()
    expect(newer.getState()).toEqual({ kind: 'available', release: RELEASE })

    const same = createUpdater(ports({ currentBuild: 14 }))
    await same.check()
    expect(same.getState().kind).toBe('current')

    const ahead = createUpdater(ports({ currentBuild: 20 }))
    await ahead.check()
    expect(ahead.getState().kind).toBe('current')
  })

  it('downloads, then opens the installer; a closed installer can be reopened', async () => {
    const port = ports()
    const updater = createUpdater(port)
    await updater.check()
    await updater.update()
    expect(port.install).toHaveBeenCalledWith('content://apk')
    expect(updater.getState()).toEqual({ kind: 'ready', release: RELEASE, apk: 'content://apk' })

    await updater.update()
    expect(port.download).toHaveBeenCalledTimes(1)
    expect(port.install).toHaveBeenCalledTimes(2)
  })

  it('reports whole percents only', async () => {
    const seen: unknown[] = []
    const updater = createUpdater(
      ports({
        download: async (_release, onProgress) => {
          onProgress(0.101)
          onProgress(0.105)
          onProgress(0.42)
          return 'content://apk'
        },
      }),
    )
    await updater.check()
    updater.subscribe(() => {
      const state = updater.getState()
      if (state.kind === 'downloading') seen.push(state.percent)
    })
    await updater.update()
    expect(seen).toEqual([null, 10, 42])
  })

  it('keeps the release through a failed download, and retries it', async () => {
    const download = vi
      .fn<UpdaterPorts['download']>()
      .mockRejectedValueOnce(new Error('cut off'))
      .mockResolvedValue('content://apk')
    const updater = createUpdater(ports({ download }))
    await updater.check()
    await updater.update()
    expect(updater.getState()).toEqual({ kind: 'download_failed', release: RELEASE })

    await updater.check()
    expect(updater.getState().kind).toBe('download_failed')

    await updater.update()
    expect(updater.getState().kind).toBe('ready')
  })

  it('an installer that refuses leaves the saved APK ready', async () => {
    const updater = createUpdater(
      ports({ install: vi.fn().mockRejectedValue(new Error('already open')) }),
    )
    await updater.check()
    await updater.update()
    expect(updater.getState().kind).toBe('ready')
  })

  it('a download started during a check is not undone by its answer', async () => {
    let answer!: (value: unknown) => void
    const fetchFeed = vi
      .fn<UpdaterPorts['fetchFeed']>()
      .mockResolvedValueOnce(RELEASE)
      .mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)))
    let finish!: (apk: string) => void
    const updater = createUpdater(
      ports({ fetchFeed, download: () => new Promise((resolve) => (finish = resolve)) }),
    )
    await updater.check()
    const recheck = updater.check()
    const update = updater.update()
    answer(RELEASE)
    await recheck
    expect(updater.getState().kind).toBe('downloading')
    finish('content://apk')
    await update
    expect(updater.getState().kind).toBe('ready')
  })

  it('a failed check says so, unless a release is already known', async () => {
    const fetchFeed = vi
      .fn<UpdaterPorts['fetchFeed']>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(RELEASE)
      .mockRejectedValueOnce(new Error('offline'))
    const updater = createUpdater(ports({ fetchFeed }))
    await updater.check()
    expect(updater.getState().kind).toBe('check_failed')
    await updater.check()
    await updater.check()
    expect(updater.getState().kind).toBe('available')
  })

  it('a background check leaves "up to date" on screen and honours its age', async () => {
    let now = 0
    const fetchFeed = vi.fn(async () => ({ ...RELEASE, build: 12 }))
    const updater = createUpdater(ports({ fetchFeed, now: () => now }))
    await updater.check()
    expect(updater.getState().kind).toBe('current')

    await updater.check(1_000)
    expect(fetchFeed).toHaveBeenCalledTimes(1)

    now = 2_000
    const seen: string[] = []
    updater.subscribe(() => seen.push(updater.getState().kind))
    await updater.check(1_000)
    expect(fetchFeed).toHaveBeenCalledTimes(2)
    expect(seen).toEqual(['current'])
  })

  it('a dismissed release leaves the home until a newer one, and tells it to draw', async () => {
    const updater = createUpdater(ports())
    await updater.check()
    const listener = vi.fn()
    updater.subscribe(listener)
    const before = updater.getState()
    updater.dismiss()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(updater.getState()).not.toBe(before)
    expect(showsHomeNotice(updater.getState(), updater.dismissedBuild())).toBe(false)
    expect(
      showsHomeNotice({ kind: 'available', release: { ...RELEASE, build: 15 } }, 14),
    ).toBe(true)
  })
})

describe('updateRowView', () => {
  it('says where the app stands and what a tap does', () => {
    expect(updateRowView({ kind: 'current' }, '0.1.12')).toMatchObject({
      title: 'Up to date',
      action: 'check',
    })
    expect(updateRowView({ kind: 'available', release: RELEASE }, '0.1.12')).toEqual({
      title: 'Update to 0.1.14',
      sub: 'On version 0.1.12 · 61 MB download',
      action: 'update',
    })
    expect(
      updateRowView({ kind: 'downloading', release: RELEASE, percent: 42 }, '0.1.12'),
    ).toMatchObject({ sub: '42%', action: null, percent: 42 })
  })
})
