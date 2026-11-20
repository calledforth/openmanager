import type { HostDeps } from '../../host.js'
import type { RuntimeTimeouts } from '../constants.js'
import { startCodexAppServer, type CodexAppServerClient } from './CodexAppServerClient.js'
import { CODEX_BIN_ENV, resolveCodexExecutable } from './executable.js'

/** The version openmanager's runtime reports in `clientInfo`, the same one
 * the ACP handshake sends (`session/wire.ts`). */
export const CODEX_CLIENT_VERSION = '0.1.0'

/** What starting an app-server needs to know. */
export type CodexStartRequest = {
  cwd: string
  env: NodeJS.ProcessEnv
  timeouts: Pick<RuntimeTimeouts, 'spawnMs' | 'initializeMs' | 'controlRequestMs' | 'terminateGraceMs'>
  log: HostDeps['log']
  /** `-c key=value` overrides for the process. */
  config?: readonly string[]
}

/** Starts one `codex app-server` and completes its handshake.
 *
 * The seam both runtime factories take, the counterpart of the ACP
 * `connections` and the Claude `sdk`: production resolves and spawns the real
 * binary, and a test hands in a starter that wires the client to a fake. */
export type CodexStarter = (request: CodexStartRequest) => Promise<CodexAppServerClient>

/** Codex is not installed where it is looked for. Carries `code: 'ENOENT'`
 * like Node's own spawn failure, which is what provider health reads as
 * "missing" rather than "broken". */
export class CodexNotInstalledError extends Error {
  readonly code = 'ENOENT'
  constructor(readonly searched: readonly string[], envOverride?: string) {
    super(
      envOverride
        ? `${CODEX_BIN_ENV} points at ${envOverride}, which is not a Codex executable.`
        : 'Codex is not installed. Install Codex or set CODEX_BIN.',
    )
    this.name = 'CodexNotInstalledError'
  }
}

export const startRealCodex: CodexStarter = async (request) => {
  const resolution = resolveCodexExecutable({ env: request.env })
  if (!resolution.found)
    throw new CodexNotInstalledError(resolution.searched, resolution.envOverride)
  return startCodexAppServer(
    {
      executable: resolution.executable,
      cwd: request.cwd,
      env: definedEnv(request.env),
      ...(request.config ? { config: request.config } : {}),
      spawnTimeoutMs: request.timeouts.spawnMs,
      clientVersion: CODEX_CLIENT_VERSION,
      initializeTimeoutMs: request.timeouts.initializeMs,
    },
    {
      log: request.log,
      terminateGraceMs: request.timeouts.terminateGraceMs,
      requestTimeoutMs: request.timeouts.controlRequestMs,
    },
  )
}

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) if (value !== undefined) out[key] = value
  return out
}
