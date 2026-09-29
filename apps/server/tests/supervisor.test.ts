import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  supervise,
  MAX_RESTARTS,
  RESTART_DELAY_MS,
  RESTART_WINDOW_MS,
  SHUTDOWN_TIMEOUT_MS,
} from '../src/service/supervisor.js'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))

class Child extends EventEmitter {
  exitCode: number | null = null
  signalCode: string | null = null
  connected = true
  send = vi.fn(() => {
    this.exitCode = 0
    this.emit('exit', 0)
  })
  kill = vi.fn(() => {
    this.signalCode = 'SIGKILL'
    this.emit('exit', null)
    return true
  })
}

const children: Child[] = []
beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(process, 'kill').mockImplementation(() => true)
  vi.mocked(spawn).mockImplementation(() => {
    const child = new Child()
    children.push(child)
    return child as unknown as ReturnType<typeof spawn>
  })
})
afterEach(() => {
  children.length = 0
  vi.restoreAllMocks()
  vi.useRealTimers()
})
const run = () =>
  supervise('/release/main.js', ['--port=0', '--exit-with-parent', '--log-level=silent'])

describe('Windows crash supervision', () => {
  it('retries nonzero exits and signals, then stops at the crash-loop limit', async () => {
    const result = run()
    for (let index = 0; index <= MAX_RESTARTS; index++) {
      children.at(-1)!.emit('exit', index % 2 === 0 ? 1 : null)
      await vi.advanceTimersByTimeAsync(RESTART_DELAY_MS)
    }
    expect(await result).toBe(1)
    expect(children).toHaveLength(MAX_RESTARTS + 1)
  })

  it('does not restart a clean exit', async () => {
    const result = run()
    children[0]!.emit('exit', 0)
    expect(await result).toBe(0)
    await vi.advanceTimersByTimeAsync(RESTART_DELAY_MS)
    expect(children).toHaveLength(1)
  })

  it('forgets failures outside the rolling restart window', async () => {
    const result = run()
    for (let index = 0; index <= MAX_RESTARTS; index++) {
      await vi.advanceTimersByTimeAsync(RESTART_WINDOW_MS + 1)
      children.at(-1)!.emit('exit', 1)
      await vi.advanceTimersByTimeAsync(RESTART_DELAY_MS)
    }
    expect(children).toHaveLength(MAX_RESTARTS + 2)
    children.at(-1)!.emit('exit', 0)
    expect(await result).toBe(0)
  })

  it('cancels a pending crash restart when the parent disappears', async () => {
    const result = run()
    children[0]!.exitCode = 1
    children[0]!.emit('exit', 1)
    await vi.advanceTimersByTimeAsync(1)
    vi.mocked(process.kill).mockImplementation(() => {
      throw new Error('ESRCH')
    })
    await vi.advanceTimersByTimeAsync(500)
    expect(await result).toBe(0)
    expect(children).toHaveLength(1)
  })

  it('requests normal shutdown over IPC instead of sending a Windows kill signal', async () => {
    const result = run()
    process.emit('message', 'shutdown', undefined)
    expect(await result).toBe(0)
    expect(children[0]!.send).toHaveBeenCalledWith('shutdown', expect.any(Function))
    expect(children[0]!.kill).not.toHaveBeenCalled()
  })

  it('bounds a stuck shutdown and never restarts it', async () => {
    const result = run()
    children[0]!.send.mockImplementation(() => {})
    process.emit('message', 'shutdown', undefined)
    await vi.advanceTimersByTimeAsync(SHUTDOWN_TIMEOUT_MS - 1)
    expect(children[0]!.kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(await result).toBe(0)
    expect(children[0]!.kill).toHaveBeenCalledWith('SIGKILL')
    expect(children).toHaveLength(1)
  })
})
