import { userInfo } from 'node:os'
import { win32 } from 'node:path'
import type { ServerConfig } from '../config.ts'
import {
  ServiceError,
  trimOutput,
  type Context,
  type RunResult,
  type ServiceBackend,
} from './context.ts'
import { describeArguments, flagValue } from './server-arguments.ts'
import { SHUTDOWN_TIMEOUT_MS, SUPERVISOR_FLAG } from './supervisor.ts'
import {
  buildTaskXml,
  encodeTaskXml,
  escapeXml,
  parseCsvRecord,
  parseTaskStatus,
  parseWindowsCommandLine,
  quoteWindowsArgument,
  readTaskArguments,
  SERVICE_MARKER_FLAG,
  serviceArguments,
  TASK_NAME,
  type TaskStatus,
} from './windows-task.ts'

/**
 * Windows: a per-user logon task (docs/windows-startup.md), managed through
 * `schtasks.exe`.
 */

// Let the launcher finish its whole grace window, including parent detection.
export const STOP_TIMEOUT_MS = SHUTDOWN_TIMEOUT_MS + 2_000
const POLL_INTERVAL_MS = 500

/** Task Scheduler result codes a user is likely to see in `status`. */
const LAST_RESULT_HINTS: Record<string, string> = {
  '0': 'last run exited cleanly',
  '1': 'last run failed; see the log file',
  '267009': 'currently running',
  '267011': 'has not run yet',
  '267014': 'last run was stopped',
  '2147942402': 'program not found; reinstall after moving Node or the repository',
  '2147942667': 'working directory missing; reinstall',
}

function schtasks(context: Context, args: readonly string[]): Promise<RunResult> {
  return context.run('schtasks.exe', args)
}

/**
 * Registered task XML, or `undefined` when Task Scheduler has no such task.
 * Absence is decided from the full task list (which succeeds whether or not
 * our task exists) rather than from a failed `/TN` query, whose error text is
 * locale-specific and also covers permission and service failures. Those are
 * surfaced instead of being mistaken for "not installed".
 */
async function readTaskXml(context: Context): Promise<string | undefined> {
  const listing = await schtasks(context, ['/Query', '/FO', 'CSV', '/NH'])
  if (listing.code !== 0) {
    throw new ServiceError(`Task Scheduler could not be queried: ${trimOutput(listing)}`)
  }
  const registered = listing.stdout
    .split(/\r?\n/)
    .some((line) => parseCsvRecord(line.trim())[0] === TASK_NAME)
  if (!registered) return undefined
  const result = await schtasks(context, ['/Query', '/TN', TASK_NAME, '/XML'])
  if (result.code !== 0) {
    throw new ServiceError(`Task Scheduler could not read ${TASK_NAME}: ${trimOutput(result)}`)
  }
  return result.stdout
}

async function readTaskStatus(context: Context): Promise<TaskStatus | undefined> {
  const result = await schtasks(context, ['/Query', '/TN', TASK_NAME, '/FO', 'CSV', '/V', '/NH'])
  return result.code === 0 ? parseTaskStatus(result.stdout) : undefined
}

/**
 * PIDs of node processes started from this entry by the task. Task Scheduler
 * only knows the console host, so stopping goes through the command line: the
 * entry path plus the marker flag identify our server and nothing else.
 * `undefined` when the lookup itself failed, which says nothing either way.
 */
async function findServerProcesses(
  context: Context,
  entry: string,
  dataDir: string | undefined,
): Promise<number[] | undefined> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()',
    'Get-CimInstance Win32_Process -Filter "Name = \'node.exe\'" |',
    '  Where-Object { $_.CommandLine } |',
    '  Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress',
  ].join('\n')
  const result = await context
    .run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ])
    .catch(() => undefined)
  if (result?.code !== 0) return undefined
  if (!result.stdout.trim()) return []
  try {
    const parsed: unknown = JSON.parse(result.stdout)
    const processes = Array.isArray(parsed) ? parsed : [parsed]
    return processes.flatMap((value: unknown) => {
      if (!value || typeof value !== 'object') throw new Error('Invalid process record')
      const record = value as { ProcessId?: unknown; CommandLine?: unknown }
      if (
        typeof record.ProcessId !== 'number' ||
        !Number.isInteger(record.ProcessId) ||
        record.ProcessId <= 0 ||
        typeof record.CommandLine !== 'string'
      )
        throw new Error('Invalid process record')
      const args = parseWindowsCommandLine(record.CommandLine)
      return args[1]?.toLowerCase() === entry.toLowerCase() &&
        args.includes(SERVICE_MARKER_FLAG) &&
        (dataDir === undefined ||
          flagValue(args, '--data-dir')?.toLowerCase() === dataDir.toLowerCase())
        ? [record.ProcessId]
        : []
    })
  } catch {
    return undefined
  }
}

function currentUserId(context: Context): string {
  const { USERDOMAIN, USERNAME } = context.env
  if (USERDOMAIN && USERNAME) return `${USERDOMAIN}\\${USERNAME}`
  return userInfo().username
}

function consoleHostPath(context: Context): string {
  const root = context.env.SystemRoot ?? context.env.windir ?? 'C:\\Windows'
  // A Windows path even when the tests run elsewhere.
  return win32.join(root, 'System32', 'conhost.exe')
}

export function createWindowsBackend(context: Context): ServiceBackend {
  let installedEntry = context.entry
  let installedDataDir: string | undefined
  return {
    kind: 'logon task',
    label: `logon task ${TASK_NAME}`,
    restartHint: 'It starts again at your next sign-in or with "service start".',

    async preflight() {},

    async running() {
      const pids = await findServerProcesses(context, installedEntry, installedDataDir)
      return pids === undefined ? undefined : pids.length > 0
    },

    async read() {
      const xml = await readTaskXml(context)
      if (xml === undefined) return undefined
      const args = parseWindowsCommandLine(readTaskArguments(xml) ?? '')
      installedEntry =
        args[0] === '--headless' ? (args[2] ?? context.entry) : (args[1] ?? context.entry)
      const installed = describeArguments(args)
      installedDataDir = installed.dataDir
      return installed
    },

    async register(config: ServerConfig, logFile: string) {
      const command = consoleHostPath(context)
      const args = [
        '--headless',
        context.execPath,
        context.entry,
        ...serviceArguments(config, logFile),
      ]
      const xml = buildTaskXml({
        userId: currentUserId(context),
        command,
        arguments: args.map(quoteWindowsArgument).join(' '),
        workingDirectory: config.dataDir,
      })
      const xmlPath = await context.writeTempFile(
        `openmanager-task-${process.pid}.xml`,
        encodeTaskXml(xml),
      )
      try {
        const created = await schtasks(context, [
          '/Create',
          '/TN',
          TASK_NAME,
          '/XML',
          xmlPath,
          '/F',
        ])
        if (created.code !== 0) {
          throw new ServiceError(`Task Scheduler refused the task: ${trimOutput(created)}`)
        }
      } finally {
        await context.removeFile(xmlPath)
      }
      context.stdout(`Registered logon task ${TASK_NAME} for ${currentUserId(context)}.`)
      return []
    },

    async start() {
      const started = await schtasks(context, ['/Run', '/TN', TASK_NAME])
      if (started.code !== 0) {
        throw new ServiceError(`Task Scheduler could not start the task: ${trimOutput(started)}`)
      }
    },

    async prepareUpdate() {
      const xml = await readTaskXml(context)
      const args = parseWindowsCommandLine(readTaskArguments(xml ?? '') ?? '')
      if (
        !xml ||
        args[0] !== '--headless' ||
        !args[2] ||
        !args.includes(SERVICE_MARKER_FLAG) ||
        (xml.match(/<Exec>/g)?.length ?? 0) !== 1
      ) {
        throw new ServiceError(
          'Cannot update this task: expected a headless server task. Reinstall it first.',
        )
      }
      args[1] = context.execPath
      args[2] = context.entry
      if (!args.includes(SUPERVISOR_FLAG)) args.splice(3, 0, SUPERVISOR_FLAG)
      const updated = xml.replace(
        /<Arguments>[\s\S]*?<\/Arguments>/,
        () => `<Arguments>${escapeXml(args.map(quoteWindowsArgument).join(' '))}</Arguments>`,
      )
      return async () => {
        const path = await context.writeTempFile(
          `openmanager-update-${process.pid}.xml`,
          encodeTaskXml(updated),
        )
        try {
          const result = await schtasks(context, ['/Create', '/TN', TASK_NAME, '/XML', path, '/F'])
          if (result.code !== 0)
            throw new ServiceError(`Task Scheduler refused the update: ${trimOutput(result)}`)
        } finally {
          await context.removeFile(path)
        }
        installedEntry = context.entry
      }
    },

    /**
     * `/End` ends the console host; the server notices its parent is gone and
     * shuts itself down. Anything still alive after the grace period is
     * terminated outright.
     */
    async stop() {
      const ended = await schtasks(context, ['/End', '/TN', TASK_NAME])
      const lookup = async () => {
        const found = await findServerProcesses(context, installedEntry, installedDataDir)
        if (found === undefined) {
          throw new ServiceError(
            'Cannot confirm the service stopped: process lookup failed. The service registration and credentials have been retained.',
          )
        }
        return found
      }
      let pids = await lookup()
      if (ended.code !== 0) {
        throw new ServiceError(`Task Scheduler could not end the task: ${trimOutput(ended)}`)
      }
      if (pids.length === 0) return 'not_running'
      const deadline = context.now() + STOP_TIMEOUT_MS
      while (pids.length > 0 && context.now() < deadline) {
        await context.sleep(POLL_INTERVAL_MS)
        pids = await lookup()
      }
      for (const pid of pids) {
        const killed = await context.run('taskkill.exe', ['/PID', String(pid), '/T', '/F'])
        if (killed.code !== 0 && (await lookup()).includes(pid)) {
          throw new ServiceError(
            `Could not terminate service process ${pid}: ${trimOutput(killed)}`,
          )
        }
      }
      if ((await lookup()).length > 0) {
        throw new ServiceError(
          'Service processes are still running; the service registration and credentials have been retained.',
        )
      }
      return 'stopped'
    },

    async remove() {
      const deleted = await schtasks(context, ['/Delete', '/TN', TASK_NAME, '/F'])
      if (deleted.code !== 0) {
        throw new ServiceError(`Task Scheduler could not delete the task: ${trimOutput(deleted)}`)
      }
    },

    async status() {
      const taskStatus = await readTaskStatus(context)
      const lines = [`Task:      ${TASK_NAME} (${taskStatus?.state ?? 'unknown'})`]
      if (taskStatus) {
        const hint = LAST_RESULT_HINTS[taskStatus.lastResult]
        lines.push(
          `Last run:  ${taskStatus.lastRunTime}, result ${taskStatus.lastResult}${hint ? ` (${hint})` : ''}`,
        )
      }
      const running = await findServerProcesses(context, installedEntry, installedDataDir)
      const state =
        running === undefined || !taskStatus
          ? 'unknown'
          : running.length > 0
            ? 'running'
            : ['0', '267011', '267014'].includes(taskStatus.lastResult)
              ? 'stopped'
              : 'failed'
      return { state, lines }
    },
  }
}
