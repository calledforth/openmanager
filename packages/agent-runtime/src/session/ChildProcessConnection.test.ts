import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AcpConnectionSpec } from './AcpConnection.js'
import { ChildProcessConnection, type TerminableChild } from './ChildProcessConnection.js'

/** A child that can be told to ignore SIGTERM.
 *
 * The real ladder cannot be tested against a spawned process on Windows: every
 * signal is the same `TerminateProcess` call there and SIGTERM cannot be
 * trapped, so a real child can never demonstrate the escalation. The narrow
 * `TerminableChild` seam exists so the ladder itself is still covered. */
class FakeChild implements TerminableChild {
  readonly pid = 999
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly signals: NodeJS.Signals[] = []
  /** A CLI mid-flush, or one that installed a handler and hung. */
  ignoreSigterm = false
  private exitListener: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal)
    if (signal === 'SIGTERM' && this.ignoreSigterm) return true
    this.die(signal)
    return true
  }

  die(signal: NodeJS.Signals | null, code: number | null = null): void {
    if (this.exitCode !== null || this.signalCode !== null) return
    this.signalCode = signal
    this.exitCode = code
    this.exitListener?.(code, signal)
  }

  on(
    _event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown {
    this.exitListener = listener
    return this
  }
}

const SPEC: AcpConnectionSpec = {
  providerId: 'cursor',
  command: 'cursor-agent',
  args: [],
  cwd: 'C:/workspace',
  env: {},
  client: {
    requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
    sessionUpdate: async () => undefined,
    extMethod: async () => ({}),
    extNotification: async () => undefined,
  },
  spawnTimeoutMs: 15_000,
  terminateGraceMs: 2_000,
}

function connect(child: FakeChild) {
  return new ChildProcessConnection(child, SPEC, vi.fn())
}

describe('ChildProcessConnection termination', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('escalates to SIGKILL when the child outlives the grace window', async () => {
    const child = new FakeChild()
    child.ignoreSigterm = true
    const connection = connect(child)

    const exited = connection.terminate({ reason: 'reaped' })
    expect(child.signals).toEqual(['SIGTERM'])

    // Not a millisecond early: the grace window is what lets a CLI flush.
    await vi.advanceTimersByTimeAsync(1_999)
    expect(child.signals).toEqual(['SIGTERM'])

    await vi.advanceTimersByTimeAsync(1)
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])
    await expect(exited).resolves.toMatchObject({ signal: 'SIGKILL', forced: true })
  })

  it('never sends SIGKILL to a child that exits inside the window', async () => {
    const child = new FakeChild()
    const connection = connect(child)

    await expect(connection.terminate({ reason: 'reaped' })).resolves.toMatchObject({
      signal: 'SIGTERM',
      forced: false,
    })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(child.signals).toEqual(['SIGTERM'])
  })

  it('sends one SIGTERM however many callers ask, and honours a caller grace', async () => {
    const child = new FakeChild()
    child.ignoreSigterm = true
    const connection = connect(child)

    const first = connection.terminate({ reason: 'disposed', graceMs: 50 })
    const second = connection.terminate({ reason: 'reaped' })
    expect(child.signals).toEqual(['SIGTERM'])

    // The second call joins the first rather than restarting the ladder, so
    // the 50ms the first caller asked for is what applies.
    await vi.advanceTimersByTimeAsync(50)
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(await first).toBe(await second)
  })

  it('reports an exit nobody asked for as unforced', async () => {
    const child = new FakeChild()
    const connection = connect(child)
    child.die(null, 1)
    await expect(connection.exited).resolves.toMatchObject({ exitCode: 1, forced: false })
    // A terminate after the fact is a no-op, not a second kill.
    await connection.terminate({ reason: 'disposed' })
    expect(child.signals).toEqual([])
  })

  it('waits for whole-tree termination and the direct child exit', async () => {
    const child = new FakeChild()
    let finishTree: ((gone: boolean) => void) | undefined
    const treeFinished = new Promise<boolean>((resolve) => {
      finishTree = resolve
    })
    const connection = new ChildProcessConnection(child, SPEC, vi.fn(), () => treeFinished)
    let settled = false
    const terminating = connection.terminate({ reason: 'disposed' }).then((exit) => {
      settled = true
      return exit
    })

    await Promise.resolve()
    expect(child.signals).toEqual([])
    expect(settled).toBe(false)

    finishTree?.(true)
    await Promise.resolve()
    expect(settled).toBe(false)

    child.die('SIGKILL')
    await expect(terminating).resolves.toMatchObject({ signal: 'SIGKILL' })
  })
})
