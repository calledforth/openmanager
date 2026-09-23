import type { ServerConfig } from '../config.ts'

/**
 * Pure helpers for the Windows logon task that keeps the environment server
 * running without the desktop app. Nothing here touches the system; the
 * command layer in `cli.ts` feeds these results to `schtasks.exe`.
 *
 * Design record: docs/decisions/windows-startup-task.md.
 */

/** Task Scheduler path. The folder groups future OpenManager tasks in the UI. */
export const TASK_NAME = '\\OpenManager\\Environment Server'

export const TASK_DESCRIPTION =
  'Starts the OpenManager environment server when you sign in and keeps it running without the desktop app.'

/** Marker flag on the task command line. It also makes the server follow its console host. */
export const SERVICE_MARKER_FLAG = '--exit-with-parent'

/**
 * Quote one argument the way `CommandLineToArgvW` will read it back. Task
 * Scheduler hands `<Arguments>` to `CreateProcess` verbatim, so this is the
 * only quoting layer.
 */
export function quoteWindowsArgument(argument: string): string {
  if (argument.length > 0 && !/[\s"]/.test(argument)) return argument
  let quoted = '"'
  let backslashes = 0
  for (const character of argument) {
    if (character === '\\') {
      backslashes += 1
      continue
    }
    if (character === '"') {
      quoted += '\\'.repeat(backslashes * 2 + 1) + '"'
    } else {
      quoted += '\\'.repeat(backslashes) + character
    }
    backslashes = 0
  }
  return `${quoted}${'\\'.repeat(backslashes * 2)}"`
}

/** Inverse of {@link quoteWindowsArgument}: split a stored command line back into arguments. */
export function parseWindowsCommandLine(commandLine: string): string[] {
  const argv: string[] = []
  let current = ''
  let inQuotes = false
  let hasToken = false
  let index = 0
  while (index < commandLine.length) {
    const character = commandLine[index]!
    if (character === '\\') {
      let count = 0
      while (commandLine[index] === '\\') {
        count += 1
        index += 1
      }
      if (commandLine[index] === '"') {
        current += '\\'.repeat(Math.floor(count / 2))
        if (count % 2 === 1) {
          current += '"'
          index += 1
        }
      } else {
        current += '\\'.repeat(count)
      }
      hasToken = true
      continue
    }
    if (character === '"') {
      inQuotes = !inQuotes
      hasToken = true
    } else if (/\s/.test(character) && !inQuotes) {
      if (hasToken) argv.push(current)
      current = ''
      hasToken = false
    } else {
      current += character
      hasToken = true
    }
    index += 1
  }
  if (hasToken) argv.push(current)
  return argv
}

const XML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
}

export function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => XML_ESCAPES[character] ?? character)
}

/**
 * The server flags baked into the task. Everything the installing shell
 * resolved (flags, environment variables, defaults) becomes explicit, so the
 * task does not depend on the environment Task Scheduler happens to provide.
 */
export function serviceArguments(config: ServerConfig, logFile: string): string[] {
  const args = [
    '--port',
    String(config.port),
    '--data-dir',
    config.dataDir,
    '--log-level',
    config.logLevel,
  ]
  for (const origin of config.allowedOrigins ?? []) args.push('--allowed-origin', origin)
  for (const host of config.allowedHosts ?? []) args.push('--allowed-host', host)
  for (const workspace of config.workspaces ?? []) args.push('--workspace', workspace)
  args.push('--log-file', logFile, SERVICE_MARKER_FLAG)
  return args
}

export interface TaskDefinition {
  /** `DOMAIN\user` (or a SID) that signs in and owns the task. */
  userId: string
  /** Absolute path of the program Task Scheduler starts. */
  command: string
  /** Already-quoted command line passed to `command`. */
  arguments: string
  workingDirectory: string
  description?: string
}

/**
 * Task Scheduler 2.0 definition. Decisions worth knowing:
 * - A logon trigger for one user with an interactive token: the server runs in
 *   the signed-in session, as that user, so provider CLIs find their logins and
 *   files, and no password is stored. Windows lets a standard user register this.
 * - `ExecutionTimeLimit` of `PT0S` disables the default 72-hour stop.
 * - `RestartOnFailure` restarts a crashed server a few times before giving up.
 * - `IgnoreNew` refuses a second instance while one runs.
 * - Battery and idle settings are disabled so a laptop keeps its environment.
 * - Priority 5 is the normal process class; the task default (7) is below normal
 *   and would slow agent work.
 */
export function buildTaskXml(task: TaskDefinition): string {
  const description = task.description ?? TASK_DESCRIPTION
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    `    <Description>${escapeXml(description)}</Description>`,
    '  </RegistrationInfo>',
    '  <Triggers>',
    '    <LogonTrigger>',
    '      <Enabled>true</Enabled>',
    `      <UserId>${escapeXml(task.userId)}</UserId>`,
    '    </LogonTrigger>',
    '  </Triggers>',
    '  <Principals>',
    '    <Principal id="Author">',
    `      <UserId>${escapeXml(task.userId)}</UserId>`,
    '      <LogonType>InteractiveToken</LogonType>',
    '      <RunLevel>LeastPrivilege</RunLevel>',
    '    </Principal>',
    '  </Principals>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <AllowHardTerminate>true</AllowHardTerminate>',
    '    <StartWhenAvailable>true</StartWhenAvailable>',
    '    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>',
    '    <IdleSettings>',
    '      <StopOnIdleEnd>false</StopOnIdleEnd>',
    '      <RestartOnIdle>false</RestartOnIdle>',
    '    </IdleSettings>',
    '    <AllowStartOnDemand>true</AllowStartOnDemand>',
    '    <Enabled>true</Enabled>',
    '    <Hidden>false</Hidden>',
    '    <RunOnlyIfIdle>false</RunOnlyIfIdle>',
    '    <WakeToRun>false</WakeToRun>',
    '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
    '    <Priority>5</Priority>',
    '    <RestartOnFailure>',
    '      <Interval>PT1M</Interval>',
    '      <Count>3</Count>',
    '    </RestartOnFailure>',
    '  </Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    `      <Command>${escapeXml(task.command)}</Command>`,
    `      <Arguments>${escapeXml(task.arguments)}</Arguments>`,
    `      <WorkingDirectory>${escapeXml(task.workingDirectory)}</WorkingDirectory>`,
    '    </Exec>',
    '  </Actions>',
    '</Task>',
    '',
  ].join('\r\n')
}

const UTF16_BOM = String.fromCharCode(0xfeff)

/** `schtasks /XML` reads UTF-16LE with a byte order mark, matching the declaration above. */
export function encodeTaskXml(xml: string): Buffer {
  return Buffer.from(`${UTF16_BOM}${xml}`, 'utf16le')
}

/** The stored `<Arguments>` of a registered task, unescaped, or `undefined` if absent. */
export function readTaskArguments(taskXml: string): string | undefined {
  const match = /<Arguments>([\s\S]*?)<\/Arguments>/.exec(taskXml)
  if (!match) return undefined
  return match[1]!.replace(/&(amp|lt|gt|quot|apos);/g, (entity) => {
    switch (entity) {
      case '&amp;':
        return '&'
      case '&lt;':
        return '<'
      case '&gt;':
        return '>'
      case '&quot;':
        return '"'
      default:
        return "'"
    }
  })
}

/** Value that follows `flag` in an argument list, or `undefined`. */
export function flagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag)
  if (index === -1) return undefined
  const value = argv[index + 1]
  return value !== undefined && !value.startsWith('--') ? value : undefined
}

/** One quoted-CSV record as `schtasks /FO CSV` prints it. */
export function parseCsvRecord(line: string): string[] {
  const fields: string[] = []
  let current = ''
  let inQuotes = false
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!
    if (inQuotes) {
      if (character === '"' && line[index + 1] === '"') {
        current += '"'
        index += 1
      } else if (character === '"') {
        inQuotes = false
      } else {
        current += character
      }
    } else if (character === '"') {
      inQuotes = true
    } else if (character === ',') {
      fields.push(current)
      current = ''
    } else {
      current += character
    }
  }
  fields.push(current)
  return fields
}

export interface TaskStatus {
  /** `Running`, `Ready`, `Disabled`, `Queued`, ... as Task Scheduler reports it. */
  state: string
  lastRunTime: string
  /** Decimal exit code of the last run, as printed; `0` also before any run. */
  lastResult: string
}

/**
 * Parse `schtasks /Query /FO CSV /V /NH` for one task. The verbose columns are
 * positional (`HostName, TaskName, Next Run Time, Status, Logon Mode, Last Run
 * Time, Last Result, ...`), which is stable across Windows locales even though
 * the header text is not.
 */
export function parseTaskStatus(csv: string): TaskStatus | undefined {
  const line = csv
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith('"'))
  if (!line) return undefined
  const fields = parseCsvRecord(line)
  if (fields.length < 7) return undefined
  return { state: fields[3]!, lastRunTime: fields[5]!, lastResult: fields[6]! }
}
