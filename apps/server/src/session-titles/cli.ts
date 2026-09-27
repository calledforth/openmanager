import { spawn } from 'node:child_process'
import { treeKiller } from '@agentpack/runtime/node'

export type CliRequest = {
  command: string
  args: readonly string[]
  /** Written to stdin, which is then closed. */
  input?: string
  cwd: string
  env: NodeJS.ProcessEnv
  timeoutMs: number
  signal?: AbortSignal
}

/** Runs a CLI to completion and answers its stdout. Injected by tests. */
export type CliRunner = (request: CliRequest) => Promise<string>

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const KILL_GRACE_MS = 2_000

/**
 * Whether a command must go through a shell to start. On Windows, npm installs
 * a CLI as a `.cmd` shim, which only a shell can launch; a real `.exe` needs
 * none, and skipping the shell is what lets its arguments carry quotes.
 */
export function needsShell(command: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' && !/\.exe$/i.test(command)
}

/**
 * One argument as `cmd.exe` passes it on. Only what the title runners send is
 * supported: arguments with double quotes are refused rather than escaped,
 * because through `cmd.exe` no escaping is reliable. Callers keep JSON off the
 * command line when `needsShell` says a shell is in the way.
 */
export function shellArgument(value: string): string {
  if (value.includes('"')) throw new Error('A shell argument cannot contain double quotes.')
  if (value === '') return '""'
  return /[\s&|<>^()%!,;=]/.test(value) ? `"${value}"` : value
}

/**
 * Settles once the CLI and everything it started have exited. A timeout or an
 * abort takes the whole process tree down before rejecting: on Windows the
 * direct child is a shell, and the CLI doing the work is its grandchild.
 */
export const runCli: CliRunner = (request) =>
  new Promise((resolve, reject) => {
    const shell = needsShell(request.command)
    const options = { cwd: request.cwd, env: request.env, windowsHide: true }
    const child = shell
      ? spawn([request.command, ...request.args].map(shellArgument).join(' '), {
          ...options,
          shell: true,
        })
      : spawn(request.command, [...request.args], options)
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let size = 0
    let stopped: { reason: Error; tree: Promise<unknown> } | undefined
    const stop = (reason: Error): void => {
      if (stopped || child.exitCode !== null || child.signalCode !== null) return
      const pid = child.pid
      stopped = {
        reason,
        tree:
          pid !== undefined && process.platform === 'win32'
            ? treeKiller(KILL_GRACE_MS)(pid).then((gone) => gone || child.kill())
            : Promise.resolve(child.kill()),
      }
    }
    const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_OUTPUT_BYTES) stop(new Error(`${request.command} wrote too much output.`))
      else chunks.push(chunk)
    }
    child.stdout.on('data', collect(stdout))
    child.stderr.on('data', collect(stderr))
    const timer = setTimeout(
      () => stop(new Error(`${request.command} did not finish within ${request.timeoutMs}ms.`)),
      request.timeoutMs,
    )
    timer.unref?.()
    const onAbort = () => stop(new Error(`${request.command} was stopped.`))
    if (request.signal?.aborted) onAbort()
    else request.signal?.addEventListener('abort', onAbort, { once: true })
    const finish = (error?: Error) => {
      clearTimeout(timer)
      request.signal?.removeEventListener('abort', onAbort)
      if (stopped) {
        const { reason, tree } = stopped
        void tree.then(
          () => reject(reason),
          () => reject(reason),
        )
        return
      }
      if (error) reject(error)
      else resolve(Buffer.concat(stdout).toString('utf8'))
    }
    child.on('error', (error) => finish(error))
    child.on('close', (code) => {
      if (code === 0 || stopped) return finish()
      const detail = Buffer.concat(stderr).toString('utf8').trim().slice(-500)
      finish(new Error(`${request.command} exited with code ${code}${detail ? `: ${detail}` : ''}`))
    })
    // A CLI that exits before reading its prompt closes stdin under us; that
    // is reported by its exit, not as an unhandled stream error.
    child.stdin.on('error', () => undefined)
    child.stdin.end(request.input ?? '')
  })
