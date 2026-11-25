import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import type { HostDeps, HostLogEntry } from '../host.js'
import type { ProcessExit, TerminationRequest } from './lifecycle.js'

/** The slice of a spawned child the lifecycle actually uses.
 *
 * Narrower than `ChildProcessWithoutNullStreams` (which satisfies it) so the
 * termination ladder can be exercised against an in-process fake. Killing a
 * real CLI is not testable on Windows, where every signal is the same
 * `TerminateProcess` call and SIGTERM cannot be trapped. */
export type TerminableChild = {
  readonly pid?: number | undefined
  readonly exitCode: number | null
  readonly signalCode: NodeJS.Signals | null
  readonly stdin: Writable
  readonly stdout: Readable
  readonly stderr: Readable
  kill(signal?: NodeJS.Signals): boolean
  on(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown
}

export type ChildProcessLifecycleOptions = {
  /** Default grace between SIGTERM and SIGKILL when the request names none. */
  graceMs: number
  log: HostDeps['log']
  /** Where the ladder's own warnings are logged, and how they name the CLI. */
  scope: HostLogEntry['scope']
  label: string
  /** Terminate the child *and every descendant*, resolving true when the
   * whole tree is gone. Supplied on win32, where the direct child is a shell
   * and killing it proves nothing about the CLI underneath. Absent on POSIX,
   * where the direct child is the CLI. */
  killTree?: (pid: number) => Promise<boolean>
}

/** How a spawned CLI dies: noticed from its own `exit` event, and ended by
 * one termination ladder whatever protocol it speaks.
 *
 * Split out of `ChildProcessConnection` so a transport that is not ACP (the
 * Codex app-server) gets the same ladder rather than a second copy of it.
 * Owns nothing about the protocol on the pipes. */
export class ChildProcessLifecycle {
  readonly exited: Promise<ProcessExit>
  private resolveExited!: (exit: ProcessExit) => void
  private exit: ProcessExit | undefined
  private termination: Promise<void> | undefined
  private killTimer: NodeJS.Timeout | undefined
  /** SIGKILL was sent because the grace window elapsed. */
  private escalated = false

  constructor(
    private readonly child: TerminableChild,
    private readonly options: ChildProcessLifecycleOptions,
  ) {
    this.exited = new Promise<ProcessExit>((resolve) => {
      this.resolveExited = resolve
    })
    child.on('exit', (code, signal) => this.settle(code, signal))
  }

  get pid(): number | undefined {
    return this.child.pid
  }

  /** Set once the child is gone. */
  get exitState(): ProcessExit | undefined {
    return this.exit
  }

  /** SIGTERM, wait out the grace window, then SIGKILL. Idempotent: a second
   * call while the first is still waiting joins it rather than restarting the
   * ladder or sending a second SIGTERM.
   *
   * On win32 the CLI is spawned through `shell: true`, so the direct child is
   * `cmd.exe` and the real agent is a powershell -> node **grandchild**.
   * Killing the shell does eventually take the CLI down, but by cascade —
   * measured at ~2s — and `exited` resolves from the *direct* child, so the
   * shutdown wait was returning in single-digit milliseconds with CLI
   * processes still running. The SIGTERM -> SIGKILL ladder was escalating
   * against a shell that was already dead.
   *
   * So on win32 the first rung is a whole-tree kill, awaited. It has to come
   * before anything kills the shell: `taskkill /T` finds descendants through
   * their parent pid, and a dead shell re-parents the CLI out of reach. The
   * signal ladder stays as the fallback and as the POSIX path, where the
   * direct child *is* the CLI and can legitimately ignore SIGTERM. */
  async terminate(request: TerminationRequest): Promise<ProcessExit> {
    if (this.exit) return this.exit
    this.termination ??= this.runLadder(request)
    await this.termination
    return this.exited
  }

  private async runLadder(request: TerminationRequest): Promise<void> {
    if (!this.alive()) return
    const graceMs = Math.max(0, request.graceMs ?? this.options.graceMs)
    const pid = this.child.pid
    if (this.options.killTree && pid !== undefined) {
      const killed = await this.options.killTree(pid).catch(() => false)
      if (killed) return
      this.options.log({
        scope: this.options.scope,
        level: 'warn',
        message: 'Could not kill the CLI process tree; falling back to signalling the shell',
        data: { pid },
      })
      if (this.exit || !this.alive()) return
    }
    this.child.kill()
    if (this.exit) return
    this.killTimer = setTimeout(() => this.forceKill(graceMs), graceMs)
    this.killTimer.unref?.()
  }

  /** The grace window elapsed and the child is still there. */
  private forceKill(graceMs: number): void {
    this.killTimer = undefined
    if (this.exit || !this.alive()) return
    this.escalated = true
    this.options.log({
      scope: this.options.scope,
      level: 'warn',
      message: `${this.options.label} process ignored SIGTERM; sending SIGKILL`,
      data: { pid: this.child.pid, graceMs },
    })
    this.child.kill('SIGKILL')
  }

  private alive(): boolean {
    return this.child.exitCode === null && this.child.signalCode === null
  }

  private settle(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exit) return
    if (this.killTimer) {
      clearTimeout(this.killTimer)
      this.killTimer = undefined
    }
    this.exit = {
      exitCode: code,
      signal,
      forced: this.escalated,
      at: new Date().toISOString(),
    }
    this.resolveExited(this.exit)
  }
}

/** `taskkill /PID <pid> /T /F` — terminate a process and its whole tree, and
 * resolve only once taskkill itself has finished, which is what makes it a
 * real wait rather than a signal fired into the dark.
 *
 * Bounded by the same grace window as the signal ladder: a `taskkill` that
 * does not answer must not hold an app quit open, and the caller falls back to
 * signalling the shell. Exit code 128 is "no such process", which for our
 * purposes is success — the tree is gone, which is all that was being asked
 * for. */
export function treeKiller(graceMs: number): (pid: number) => Promise<boolean> {
  return (pid) =>
    new Promise<boolean>((resolve) => {
      let settled = false
      const finish = (value: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      }
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      const timer = setTimeout(() => {
        killer.kill()
        finish(false)
      }, Math.max(1_000, graceMs))
      timer.unref?.()
      killer.on('error', () => finish(false))
      killer.on('exit', (code) => finish(code === 0 || code === 128))
    })
}

/** The OS did not report the child running in time. On a machine under load
 * (swapping, thermally throttled) this is slowness, not a broken CLI, so it is
 * kept apart from a spawn that failed outright. The message is unchanged:
 * probes still read it as a spawn failure. */
export class SpawnTimeoutError extends Error {
  readonly name = 'SpawnTimeoutError'
  constructor(
    readonly label: string,
    readonly timeoutMs: number,
  ) {
    super(`${label} did not start within ${timeoutMs}ms`)
  }
}

/** Resolve once Node reports the child running, reject if it could not be
 * started at all. Without this a missing binary surfaces much later, as a
 * handshake that never answers. */
export function spawned(
  child: ChildProcessWithoutNullStreams,
  spec: { label: string; spawnTimeoutMs: number },
): Promise<void> {
  if (child.pid !== undefined) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined
    const finish = (error?: Error): void => {
      if (timer) clearTimeout(timer)
      child.off('spawn', onSpawn)
      child.off('error', onError)
      if (error) reject(error)
      else resolve()
    }
    const onSpawn = (): void => finish()
    const onError = (error: Error): void => finish(error)
    child.once('spawn', onSpawn)
    child.once('error', onError)
    timer = setTimeout(() => {
      child.kill()
      finish(new SpawnTimeoutError(spec.label, spec.spawnTimeoutMs))
    }, spec.spawnTimeoutMs)
    timer.unref?.()
  })
}
