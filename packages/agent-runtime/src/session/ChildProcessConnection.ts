import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'
import type { HostDeps } from '../host.js'
import type { AcpConnection, AcpConnectionFactory, AcpConnectionSpec } from './AcpConnection.js'
import type { ProcessExit, TerminationRequest } from './lifecycle.js'

/** The slice of a spawned child this connection actually uses.
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

/** One spawned CLI plus its ACP connection. Owns nothing above the transport:
 * no sessions, no config state, no event fan-out.
 *
 * `exited` resolves from the child's own `exit` event, not from an RPC
 * failing, so a dead process is noticed immediately instead of on the next
 * user turn. */
export class ChildProcessConnection implements AcpConnection {
  readonly connection: acp.ClientSideConnection
  readonly exited: Promise<ProcessExit>
  private resolveExited!: (exit: ProcessExit) => void
  private exit: ProcessExit | undefined
  private readonly graceMs: number
  private termination: Promise<void> | undefined
  private killTimer: NodeJS.Timeout | undefined
  /** SIGKILL was sent because the grace window elapsed. */
  private escalated = false

  constructor(
    private readonly child: TerminableChild,
    spec: AcpConnectionSpec,
    private readonly log: HostDeps['log'],
    /** Terminate the child *and every descendant*, resolving true when the
     * whole tree is gone. Supplied on win32, where the direct child is a shell
     * and killing it proves nothing about the CLI underneath. Absent on POSIX,
     * where the direct child is the CLI. */
    private readonly killTree?: (pid: number) => Promise<boolean>,
  ) {
    this.graceMs = spec.terminateGraceMs
    this.exited = new Promise<ProcessExit>((resolve) => {
      this.resolveExited = resolve
    })
    this.connection = new acp.ClientSideConnection(
      () => spec.client,
      acp.ndJsonStream(
        Writable.toWeb(child.stdin),
        // The SDK's web-stream adapter is typed against the DOM ReadableStream;
        // Node's is structurally compatible at runtime.
        Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
      ),
    )
    child.stderr.on('data', (data) =>
      this.log({
        scope: 'acp',
        level: 'warn',
        message: 'ACP stderr output',
        data: { providerId: spec.providerId, text: String(data) },
      }),
    )
    child.on('exit', (code, signal) => this.settle(code, signal))
  }

  get pid(): number | undefined {
    return this.child.pid
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
    const graceMs = Math.max(0, request.graceMs ?? this.graceMs)
    const pid = this.child.pid
    if (this.killTree && pid !== undefined) {
      const killed = await this.killTree(pid).catch(() => false)
      if (killed) return
      this.log({
        scope: 'acp',
        level: 'warn',
        message: 'Could not kill the CLI process tree; falling back to signalling the shell',
        data: { pid },
      })
      if (this.exit || !this.alive()) return
    }
    this.child.kill()
    if (this.exit) return
    this.killTimer = setTimeout(() => this.forceKill(), graceMs)
    this.killTimer.unref?.()
  }

  /** The grace window elapsed and the child is still there. */
  private forceKill(): void {
    this.killTimer = undefined
    if (this.exit || !this.alive()) return
    this.escalated = true
    this.log({
      scope: 'acp',
      level: 'warn',
      message: 'ACP process ignored SIGTERM; sending SIGKILL',
      data: { pid: this.child.pid, graceMs: this.graceMs },
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

export class ChildProcessConnectionFactory implements AcpConnectionFactory {
  constructor(private readonly log: HostDeps['log']) {}

  async connect(spec: AcpConnectionSpec): Promise<AcpConnection> {
    const child = spawn(spec.command, [...spec.args], {
      cwd: spec.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      // `shell: true` is what makes a `.cmd` shim launchable at all on
      // Windows, and it is why `child.kill()` reaches anything there. It is
      // also why the process that matters is a grandchild — see `killTree`.
      shell: process.platform === 'win32',
      env: { ...spec.env },
    })
    await spawned(child, spec)
    return new ChildProcessConnection(
      child,
      spec,
      this.log,
      process.platform === 'win32' ? treeKiller(spec.terminateGraceMs) : undefined,
    )
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
function treeKiller(graceMs: number): (pid: number) => Promise<boolean> {
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

/** Resolve once Node reports the child running, reject if it could not be
 * started at all. `AcpBackend` had neither check: a missing binary surfaced
 * much later as an `initialize` that never answered. */
function spawned(child: ChildProcessWithoutNullStreams, spec: AcpConnectionSpec): Promise<void> {
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
      finish(new Error(`${spec.providerId} did not start within ${spec.spawnTimeoutMs}ms`))
    }, spec.spawnTimeoutMs)
    timer.unref?.()
  })
}
