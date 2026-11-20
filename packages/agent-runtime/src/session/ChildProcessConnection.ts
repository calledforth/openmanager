import { spawn, type SpawnOptionsWithoutStdio } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'
import type { HostDeps } from '../host.js'
import type { AcpConnection, AcpConnectionFactory, AcpConnectionSpec } from './AcpConnection.js'
import {
  ChildProcessLifecycle,
  spawned,
  treeKiller,
  type TerminableChild,
} from './ChildProcessLifecycle.js'
import type { ProcessExit, TerminationRequest } from './lifecycle.js'

// Moved to `ChildProcessLifecycle`; re-exported for existing importers.
export { treeKiller, type TerminableChild }

/** One spawned CLI plus its ACP connection. Owns nothing above the transport:
 * no sessions, no config state, no event fan-out.
 *
 * `exited` resolves from the child's own `exit` event, not from an RPC
 * failing, so a dead process is noticed immediately instead of on the next
 * user turn. How the child dies is `ChildProcessLifecycle`'s, shared with the
 * Codex transport. */
export class ChildProcessConnection implements AcpConnection {
  readonly connection: acp.ClientSideConnection
  readonly exited: Promise<ProcessExit>
  private readonly lifecycle: ChildProcessLifecycle

  constructor(
    child: TerminableChild,
    spec: AcpConnectionSpec,
    log: HostDeps['log'],
    /** See `ChildProcessLifecycleOptions.killTree`. */
    killTree?: (pid: number) => Promise<boolean>,
  ) {
    this.lifecycle = new ChildProcessLifecycle(child, {
      graceMs: spec.terminateGraceMs,
      log,
      scope: 'acp',
      label: 'ACP',
      ...(killTree ? { killTree } : {}),
    })
    this.exited = this.lifecycle.exited
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
      log({
        scope: 'acp',
        level: 'warn',
        message: 'ACP stderr output',
        data: { providerId: spec.providerId, text: String(data) },
      }),
    )
  }

  get pid(): number | undefined {
    return this.lifecycle.pid
  }

  /** See `ChildProcessLifecycle.terminate`. */
  terminate(request: TerminationRequest): Promise<ProcessExit> {
    return this.lifecycle.terminate(request)
  }
}

export class ChildProcessConnectionFactory implements AcpConnectionFactory {
  constructor(private readonly log: HostDeps['log']) {}

  async connect(spec: AcpConnectionSpec): Promise<AcpConnection> {
    // `shell: true` is what makes a `.cmd` shim launchable at all on Windows,
    // and it is why `child.kill()` reaches anything there. It is also why the
    // process that matters is a grandchild — see `killTree`.
    const shell = process.platform === 'win32'
    // `windowsHide`: a host without a console of its own (the Windows service)
    // would otherwise give the shell a new console, and Windows 11 shows that
    // as an empty terminal window; closing it kills the agent.
    const options: SpawnOptionsWithoutStdio = {
      cwd: spec.cwd,
      env: { ...spec.env },
      windowsHide: true,
    }
    const child = shell
      ? // Through a shell Node joins the arguments onto the command itself,
        // unescaped, and warns on stderr that it did (DEP0190). Handing it
        // the same line already joined runs the same command without the
        // warning, which would otherwise greet every host that probes its
        // providers at boot.
        spawn([spec.command, ...spec.args].join(' '), { ...options, shell: true })
      : spawn(spec.command, [...spec.args], options)
    await spawned(child, { label: spec.providerId, spawnTimeoutMs: spec.spawnTimeoutMs })
    return new ChildProcessConnection(
      child,
      spec,
      this.log,
      process.platform === 'win32' ? treeKiller(spec.terminateGraceMs) : undefined,
    )
  }
}
