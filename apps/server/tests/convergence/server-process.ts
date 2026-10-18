import { fork, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type {
  ChildConfig,
  ChildMessage,
  ProviderOp,
  ServerOp,
  ServerThreadRead,
  SocketSample,
  AuditRow,
} from './child-protocol.ts'

const CHILD_ENTRY = fileURLToPath(new URL('./server-child.ts', import.meta.url))
const READY_TIMEOUT_MS = 30_000
const EXIT_TIMEOUT_MS = 15_000

/** A close the server initiated, seen from inside the server process. */
export interface ServerClose {
  generation: number
  socket: number
  remotePort: number | undefined
  code: number | undefined
  reason: string
  /** `performance.now()` in this process when the report arrived (the child's own clock differs). */
  at: number
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; op: string }

/**
 * The parent's handle on the server child. One handle survives restarts:
 * each spawn is a new generation on the same data directory, and every
 * request goes to the live one.
 */
export class ServerProcess {
  private child: ChildProcess | undefined
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private stderr = ''
  generation = 0
  port = 0
  environmentId = ''
  pid = 0
  readonly closes: ServerClose[] = []
  /** Uncaught failures inside the child; a scenario fails on any of them. */
  readonly fatals: string[] = []

  private constructor(private readonly config: ChildConfig) {}

  static async start(config: ChildConfig): Promise<ServerProcess> {
    const handle = new ServerProcess(config)
    await handle.spawn()
    return handle
  }

  get running(): boolean {
    return (
      this.child !== undefined && this.child.exitCode === null && this.child.signalCode === null
    )
  }

  /** The tail of the child's stderr, for failure reports. */
  diagnostics(): string {
    return this.stderr.slice(-8_000)
  }

  private async spawn(): Promise<void> {
    this.generation += 1
    const generation = this.generation
    const child = fork(CHILD_ENTRY, [], {
      // Plain Node strips the types; nothing of vitest's own loader comes along.
      execArgv: [],
      env: {
        ...process.env,
        NODE_OPTIONS: '',
        CONVERGENCE_CHILD_CONFIG: JSON.stringify(this.config),
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      serialization: 'advanced',
    })
    this.child = child
    child.stdout?.on('data', (chunk: Buffer) => {
      this.stderr += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      this.stderr += chunk.toString('utf8')
    })
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`The server child did not start.\n${this.diagnostics()}`)),
        READY_TIMEOUT_MS,
      )
      child.on('message', (message: ChildMessage) => {
        if (message.type === 'ready') {
          clearTimeout(timer)
          this.port = message.port
          this.environmentId = message.environmentId
          this.pid = message.pid
          resolve()
        } else if (message.type === 'fatal') {
          this.fatals.push(message.error)
          clearTimeout(timer)
          reject(new Error(`The server child failed: ${message.error}`))
        } else if (message.type === 'serverClose') {
          this.closes.push({ generation, ...message, at: performance.now() })
        } else if (message.type === 'reply') {
          const pending = this.pending.get(message.id)
          if (!pending) return
          this.pending.delete(message.id)
          if (message.ok) pending.resolve(message.result)
          else
            pending.reject(new Error(`${pending.op} failed in the server child: ${message.error}`))
        }
      })
      child.once('exit', (code, signal) => {
        clearTimeout(timer)
        reject(new Error(`The server child exited (${code ?? signal}).\n${this.diagnostics()}`))
        // Only one child runs at a time, so everything pending was sent to this one.
        for (const [id, pending] of this.pending) {
          this.pending.delete(id)
          pending.reject(new Error(`${pending.op}: the server child exited (${code ?? signal}).`))
        }
      })
    })
    await ready
  }

  call<T = unknown>(request: ProviderOp | ServerOp): Promise<T> {
    const child = this.child
    if (!child || !this.running)
      return Promise.reject(new Error('The server child is not running.'))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, op: request.op })
      child.send({ ...request, id })
    })
  }

  waitQuiet(quietMs = 300, timeoutMs = 30_000): Promise<void> {
    return this.call({ op: 'waitQuiet', quietMs, timeoutMs })
  }

  readThread(sessionId: string, threadId: string): Promise<ServerThreadRead> {
    return this.call({ op: 'readThread', sessionId, threadId })
  }

  /** Host session id → when its provider session resolved (epoch ms), for this generation. */
  readStamps(): Promise<Record<string, number>> {
    return this.call({ op: 'readStamps' })
  }

  readSessionThreads(sessionId: string): Promise<string[]> {
    return this.call({ op: 'readSessionThreads', sessionId })
  }

  readSessions(): Promise<unknown[]> {
    return this.call({ op: 'readSessions' })
  }

  /** The provenance audit (child-protocol.ts `AuditRow`), oldest first, across every generation. */
  readAudit(): Promise<AuditRow[]> {
    return this.call({ op: 'readAudit' })
  }

  /** Sessions whose row holds no provider session identity. */
  readUnidentified(): Promise<string[]> {
    return this.call({ op: 'readUnidentified' })
  }

  sampleSockets(): Promise<SocketSample[]> {
    return this.call({ op: 'sampleSockets' })
  }

  private exited(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('The server child did not exit.')),
        EXIT_TIMEOUT_MS,
      )
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  /** The server's own shutdown path, then a new process on the same data. */
  async restart(): Promise<void> {
    const child = this.child
    if (child && this.running) {
      const exit = this.exited(child)
      await this.call({ op: 'shutdown' }).catch(() => undefined)
      await exit
    }
    await this.spawn()
  }

  /** A hard kill (no shutdown path at all), then a new process on the same data. */
  async crash(): Promise<void> {
    await this.kill()
    await this.spawn()
  }

  /** Kill the exact process this handle started. */
  async kill(): Promise<void> {
    const child = this.child
    if (!child || !this.running) return
    const exit = this.exited(child)
    child.kill('SIGKILL')
    await exit
  }

  async stop(): Promise<void> {
    const child = this.child
    if (!child || !this.running) return
    const exit = this.exited(child)
    await this.call({ op: 'shutdown' }).catch(() => undefined)
    await exit.catch(async () => {
      await this.kill()
    })
  }
}
