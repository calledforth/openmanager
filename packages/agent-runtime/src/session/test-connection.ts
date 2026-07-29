import type * as acp from '@agentclientprotocol/sdk'
import type { AcpConnection, AcpConnectionFactory, AcpConnectionSpec } from './AcpSessionRuntime.js'
import type { ProcessExit, TerminationRequest } from './lifecycle.js'

/** The `AcpConnectionFactory` seam, faked.
 *
 * `AcpBackend`'s tests injected state by overwriting private fields
 * (`internals.connection`, `internals.process`). A session runtime takes its
 * transport as a dependency instead, so tests drive the real code path: spawn,
 * handshake, session, prompt, exit. Everything in this file exists only for
 * tests; nothing in the shipping paths imports it. */

/** The wire methods a test cares about. Anything a test leaves out and the
 * runtime calls surfaces as a normal "not a function" failure. */
export type FakeWire = {
  initialize?: (params: unknown) => Promise<unknown>
  authenticate?: (params: unknown) => Promise<unknown>
  newSession?: (params: unknown) => Promise<unknown>
  loadSession?: (params: unknown) => Promise<unknown>
  listSessions?: (params: unknown) => Promise<unknown>
  prompt?: (params: unknown) => Promise<unknown>
  cancel?: (params: unknown) => Promise<unknown>
  setSessionMode?: (params: unknown) => Promise<unknown>
  setSessionConfigOption?: (params: unknown) => Promise<unknown>
  request?: (method: string, params: unknown) => Promise<unknown>
}

const DEFAULT_WIRE: FakeWire = {
  initialize: async () => ({ protocolVersion: 1, authMethods: [] }),
}

export class FakeAcpConnection implements AcpConnection {
  readonly connection: acp.ClientSideConnection
  readonly pid = 4242
  readonly exited: Promise<ProcessExit>
  readonly client: acp.Client
  terminated: TerminationRequest | undefined

  private resolveExited!: (exit: ProcessExit) => void
  private exit: ProcessExit | undefined

  constructor(
    readonly spec: AcpConnectionSpec,
    wire: FakeWire,
  ) {
    this.client = spec.client
    this.connection = { ...DEFAULT_WIRE, ...wire } as unknown as acp.ClientSideConnection
    this.exited = new Promise<ProcessExit>((resolve) => {
      this.resolveExited = resolve
    })
  }

  async terminate(request: TerminationRequest): Promise<ProcessExit> {
    this.terminated = request
    this.settle({ exitCode: 0, signal: 'SIGTERM', forced: false, at: new Date().toISOString() })
    return this.exited
  }

  /** The child dying on its own — nobody asked. */
  crash(exitCode = 1): Promise<ProcessExit> {
    this.settle({ exitCode, signal: null, forced: false, at: new Date().toISOString() })
    return this.exited
  }

  // Agent-initiated traffic, as the child would send it.
  requestPermission(params: Record<string, unknown>): Promise<acp.RequestPermissionResponse> {
    return Promise.resolve(
      this.client.requestPermission(params as unknown as acp.RequestPermissionRequest),
    )
  }
  sessionUpdate(params: { sessionId: string; update: Record<string, unknown> }): Promise<void> {
    return Promise.resolve(
      this.client.sessionUpdate(params as unknown as acp.SessionNotification),
    ).then(() => undefined)
  }
  elicit(params: Record<string, unknown>): Promise<acp.CreateElicitationResponse> {
    const handler = this.client.unstable_createElicitation
    if (!handler) throw new Error('client does not handle elicitation')
    return Promise.resolve(
      handler.call(this.client, params as unknown as acp.CreateElicitationRequest),
    )
  }
  extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return extMethod(this.client, method, params)
  }
  extNotification(method: string, params: Record<string, unknown>): Promise<void> {
    const handler = this.client.extNotification
    if (!handler) throw new Error('client does not handle ext notifications')
    return Promise.resolve(handler.call(this.client, method, params)).then(() => undefined)
  }

  private settle(exit: ProcessExit): void {
    if (this.exit) return
    this.exit = exit
    this.resolveExited(exit)
  }
}

/** Send a `session/update` straight at the client handlers, for wire stubs that
 * have to notify *during* an RPC (agents replay a transcript before
 * `session/load` answers). */
export function notify(
  client: acp.Client,
  params: { sessionId: string; update: Record<string, unknown> },
): Promise<void> {
  return Promise.resolve(client.sessionUpdate(params as unknown as acp.SessionNotification)).then(
    () => undefined,
  )
}

/** Call an ext method straight on the client handlers, for wire stubs that
 * have to send one *during* an RPC. */
export function extMethod(
  client: acp.Client,
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const handler = client.extMethod
  if (!handler) throw new Error('client does not handle ext methods')
  return Promise.resolve(handler.call(client, method, params))
}

export class FakeConnectionFactory implements AcpConnectionFactory {
  readonly connections: FakeAcpConnection[] = []
  /** Set to reject the next `connect`, standing in for a missing CLI. */
  failWith: Error | undefined

  constructor(private readonly wire: FakeWire | ((spec: AcpConnectionSpec) => FakeWire) = {}) {}

  async connect(spec: AcpConnectionSpec): Promise<AcpConnection> {
    if (this.failWith) throw this.failWith
    const wire = typeof this.wire === 'function' ? this.wire(spec) : this.wire
    const connection = new FakeAcpConnection(spec, wire)
    this.connections.push(connection)
    return connection
  }

  get last(): FakeAcpConnection {
    const connection = this.connections.at(-1)
    if (!connection) throw new Error('nothing has connected yet')
    return connection
  }
}
