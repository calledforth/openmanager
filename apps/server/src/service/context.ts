import { spawn } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import type { ServerConfig } from '../config.ts'

/**
 * What the `service` command flow and its platform backends share. Every
 * system interaction goes through `ServiceCommandDeps`, so the flow is
 * testable without Task Scheduler or systemd.
 */

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

export interface ServiceCommandDeps {
  /** Absolute path of the server entry the service should run (normally `dist/main.js`). */
  entry: string
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  /** Node binary baked into the service. Defaults to the one running this command. */
  execPath?: string
  /** Real user ID on POSIX; `undefined` on Windows. */
  uid?: number | undefined
  username?: string
  homedir?: string
  run?: (file: string, args: readonly string[]) => Promise<RunResult>
  writeTempFile?: (name: string, data: Buffer) => Promise<string>
  /** Text of a file, or `undefined` when it does not exist. */
  readFile?: (path: string) => Promise<string | undefined>
  writeFile?: (path: string, text: string) => Promise<void>
  removeFile?: (path: string) => Promise<void>
  ensureDir?: (path: string) => Promise<void>
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  /** Clock for the health and stop deadlines; tests pair it with `sleep`. */
  now?: () => number
  stdout?: (line: string) => void
  stderr?: (line: string) => void
}

export interface Context extends Required<Omit<ServiceCommandDeps, 'uid'>> {
  uid: number | undefined
}

function defaultRun(file: string, args: readonly string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, stdout, stderr }))
  })
}

async function defaultWriteTempFile(name: string, data: Buffer): Promise<string> {
  const path = join(tmpdir(), name)
  await writeFile(path, data)
  return path
}

async function defaultReadFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export function resolveDeps(deps: ServiceCommandDeps): Context {
  return {
    entry: deps.entry,
    platform: deps.platform ?? process.platform,
    env: deps.env ?? process.env,
    execPath: deps.execPath ?? process.execPath,
    uid: 'uid' in deps ? deps.uid : process.getuid?.(),
    username: deps.username ?? userInfo().username,
    homedir: deps.homedir ?? homedir(),
    run: deps.run ?? defaultRun,
    writeTempFile: deps.writeTempFile ?? defaultWriteTempFile,
    readFile: deps.readFile ?? defaultReadFile,
    writeFile: deps.writeFile ?? ((path, text) => writeFile(path, text, 'utf8')),
    removeFile: deps.removeFile ?? ((path) => rm(path, { force: true })),
    ensureDir: deps.ensureDir ?? (async (path) => void (await mkdir(path, { recursive: true }))),
    fetch: deps.fetch ?? fetch,
    sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    now: deps.now ?? Date.now,
    stdout: deps.stdout ?? ((line) => console.log(line)),
    stderr: deps.stderr ?? ((line) => console.error(line)),
  }
}

/** An expected failure: printed to stderr and turned into exit code 1. */
export class ServiceError extends Error {}

export function trimOutput(result: RunResult): string {
  return `${result.stderr}${result.stdout}`.trim().replace(/\s+/g, ' ')
}

export function defaultLogFile(dataDir: string): string {
  return join(dataDir, 'logs', 'server.log')
}

/** What an installed service was set up with, read back from its definition. */
export interface InstalledService {
  port: number | undefined
  dataDir: string | undefined
  logFile: string | undefined
}

/**
 * One platform's supervisor. The shared flow in `cli.ts` owns flag handling,
 * the port-conflict check and the `/health` wait; a backend only registers,
 * starts, stops and describes its own kind of service.
 */
export interface ServiceBackend {
  /** Kind of service, as in "Replacing the existing logon task." */
  readonly kind: string
  /** Kind plus name, as in "No logon task \OpenManager\Environment Server is installed." */
  readonly label: string
  /** Printed after `stop`: when the stopped server comes back on its own. */
  readonly restartHint: string
  /** Throws a {@link ServiceError} when this machine cannot host the service at all. */
  preflight(): Promise<void>
  read(): Promise<InstalledService | undefined>
  /** Write and register the definition. Returns notes printed before the first start. */
  register(config: ServerConfig, logFile: string): Promise<string[]>
  start(): Promise<void>
  stop(): Promise<'stopped' | 'not_running'>
  remove(): Promise<void>
  /** Platform lines that open `status`, before the shared server lines. */
  status(): Promise<string[]>
}
