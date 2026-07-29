import { describe, expect, it, vi } from 'vitest'
import type { ThreadId } from '../session/lifecycle.js'
import { SessionReaper } from './SessionReaper.js'

function build(reapIdle: (idleMs: number, now?: number) => Promise<readonly ThreadId[]>) {
  const log = vi.fn()
  let run: (() => void) | undefined
  const reaper = new SessionReaper({
    registry: { reapIdle },
    log,
    idleMs: 1_000,
    sweepMs: 100,
    schedule: (fn) => {
      run = fn
      return { cancel: () => (run = undefined) }
    },
  })
  return { reaper, log, tick: () => run?.(), scheduled: () => run !== undefined }
}

describe('SessionReaper', () => {
  it('sweeps on the interval with its idle threshold, and stops when told', async () => {
    const reapIdle = vi.fn(async () => ['thread-1'])
    const { reaper, tick, scheduled } = build(reapIdle)

    reaper.start()
    expect(reapIdle).not.toHaveBeenCalled()

    tick()
    await vi.waitFor(() => expect(reapIdle).toHaveBeenCalledWith(1_000, expect.any(Number)))

    reaper.stop()
    expect(scheduled()).toBe(false)
  })

  it('never overlaps two sweeps', async () => {
    let release: (() => void) | undefined
    const blocked = new Promise<void>((resolve) => (release = resolve))
    const reapIdle = vi.fn(async () => {
      await blocked
      return []
    })
    const { reaper } = build(reapIdle)

    const first = reaper.sweep()
    // A slow `stop()` must not let sweeps stack up behind it.
    const second = reaper.sweep()
    expect(reapIdle).toHaveBeenCalledTimes(1)
    expect(second).toBe(first)

    release?.()
    await first
    await reaper.sweep()
    expect(reapIdle).toHaveBeenCalledTimes(2)
  })

  it('keeps sweeping after one fails rather than dying silently', async () => {
    let calls = 0
    const { reaper, log } = build(async () => {
      if (++calls === 1) throw new Error('stop() hung')
      return ['thread-2']
    })

    await expect(reaper.sweep()).resolves.toEqual([])
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'warn', message: 'Idle session sweep failed' }),
    )
    await expect(reaper.sweep()).resolves.toEqual(['thread-2'])
  })
})
