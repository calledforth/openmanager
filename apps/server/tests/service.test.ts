import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  defaultLogFile,
  runServiceCommand,
  type RunResult,
  type ServiceCommandDeps,
} from '../src/service/cli.js'
import {
  buildTaskXml,
  encodeTaskXml,
  flagValue,
  parseTaskStatus,
  parseWindowsCommandLine,
  quoteWindowsArgument,
  readTaskArguments,
  serviceArguments,
  TASK_NAME,
} from '../src/service/windows-task.js'

const ENTRY = 'C:\\Users\\Ada Lovelace\\openmanager\\apps\\server\\dist\\main.js'
const NODE = 'C:\\Program Files\\nodejs\\node.exe'
const DATA_DIR = 'C:\\Users\\Ada Lovelace\\.openmanager'

describe('Windows command-line quoting', () => {
  it.each([
    ['plain', 'plain'],
    ['with space', '"with space"'],
    ['C:\\path\\', 'C:\\path\\'],
    ['C:\\path with space\\', '"C:\\path with space\\\\"'],
    ['say "hi"', '"say \\"hi\\""'],
    ['back\\"slash', '"back\\\\\\"slash"'],
    ['', '""'],
  ])('quotes %j so CreateProcess reads it back unchanged', (argument, quoted) => {
    expect(quoteWindowsArgument(argument)).toBe(quoted)
    expect(parseWindowsCommandLine(quoted)).toEqual([argument])
  })

  it('round-trips a whole task command line', () => {
    const argv = ['--headless', NODE, ENTRY, '--port', '43120', '--data-dir', DATA_DIR]
    expect(parseWindowsCommandLine(argv.map(quoteWindowsArgument).join(' '))).toEqual(argv)
  })
})

describe('task definition', () => {
  const config = {
    port: 43120,
    dataDir: DATA_DIR,
    logLevel: 'info' as const,
    allowedOrigins: ['http://localhost:5173'],
    allowedHosts: ['tunnel.example'],
    workspaces: ['C:\\src\\repo'],
  }

  it('bakes every resolved server setting into explicit flags plus the marker', () => {
    expect(serviceArguments(config, 'C:\\logs\\server.log')).toEqual([
      '--port',
      '43120',
      '--data-dir',
      DATA_DIR,
      '--log-level',
      'info',
      '--allowed-origin',
      'http://localhost:5173',
      '--allowed-host',
      'tunnel.example',
      '--workspace',
      'C:\\src\\repo',
      '--log-file',
      'C:\\logs\\server.log',
      '--exit-with-parent',
    ])
  })

  it('emits a per-user interactive logon task without a time limit and with restart on failure', () => {
    const xml = buildTaskXml({
      userId: 'MACHINE\\ada',
      command: 'C:\\Windows\\System32\\conhost.exe',
      arguments: '--headless "a & b" <x>',
      workingDirectory: DATA_DIR,
    })
    expect(xml).toContain('<LogonTrigger>')
    expect(xml).toContain('<UserId>MACHINE\\ada</UserId>')
    expect(xml).toContain('<LogonType>InteractiveToken</LogonType>')
    expect(xml).toContain('<RunLevel>LeastPrivilege</RunLevel>')
    expect(xml).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>')
    expect(xml).toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>')
    expect(xml).toContain('<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>')
    expect(xml).toContain('<RestartOnFailure>')
    expect(xml).toContain('<Arguments>--headless &quot;a &amp; b&quot; &lt;x&gt;</Arguments>')
    expect(xml).toContain(`<WorkingDirectory>${DATA_DIR}</WorkingDirectory>`)
    // Task Scheduler reads the file as UTF-16LE with a byte order mark.
    const encoded = encodeTaskXml(xml)
    expect([...encoded.subarray(0, 4)]).toEqual([0xff, 0xfe, 0x3c, 0x00])
    expect(readTaskArguments(xml)).toBe('--headless "a & b" <x>')
  })

  it('reads the port, data directory and log file back out of a registered task', () => {
    const args = serviceArguments(config, 'C:\\logs\\server.log')
    const xml = buildTaskXml({
      userId: 'MACHINE\\ada',
      command: 'conhost.exe',
      arguments: ['--headless', NODE, ENTRY, ...args].map(quoteWindowsArgument).join(' '),
      workingDirectory: DATA_DIR,
    })
    const argv = parseWindowsCommandLine(readTaskArguments(xml) ?? '')
    expect(flagValue(argv, '--port')).toBe('43120')
    expect(flagValue(argv, '--data-dir')).toBe(DATA_DIR)
    expect(flagValue(argv, '--log-file')).toBe('C:\\logs\\server.log')
    expect(flagValue(argv, '--missing')).toBeUndefined()
  })

  it('parses the verbose CSV status even though schtasks does not escape the command column', () => {
    const csv =
      '"HOST","\\OpenManager\\Environment Server","N/A","Running","Interactive only","9/23/2026 4:24:38 PM","267009","N/A","C:\\Windows\\System32\\conhost.exe --headless "C:\\node.exe" "C:\\main.js"","C:\\data","N/A","Enabled"\r\n'
    expect(parseTaskStatus(csv)).toEqual({
      state: 'Running',
      lastRunTime: '9/23/2026 4:24:38 PM',
      lastResult: '267009',
    })
    expect(parseTaskStatus('ERROR: The system cannot find the file specified.')).toBeUndefined()
  })

  it('places the default log file under the data directory', () => {
    expect(defaultLogFile(DATA_DIR)).toBe(join(DATA_DIR, 'logs', 'server.log'))
  })
})

/** A scripted Task Scheduler: `registered` is the XML it returns for /Query /XML. */
function fakeSystem(options: {
  registered?: string
  healthy?: () => boolean
  pids?: number[][]
  /** Something unrelated keeps answering /health even after our task is ended. */
  otherServer?: boolean
  /** Task Scheduler itself is unreachable. */
  queryFails?: boolean
}) {
  const calls: string[][] = []
  const out: string[] = []
  const err: string[] = []
  const written: { name: string; data: Buffer }[] = []
  const removed: string[] = []
  const dirs: string[] = []
  let registered = options.registered
  let health = options.healthy ?? (() => false)
  // Scripted process lookups; the last entry repeats so a straggler stays put.
  const pidQueue = [...(options.pids ?? [])]
  let clock = 0
  const run = async (file: string, args: readonly string[]): Promise<RunResult> => {
    calls.push([file, ...args])
    if (file === 'schtasks.exe') {
      const verb = args[0]
      if (verb === '/Query' && options.queryFails) {
        return {
          code: 1,
          stdout: '',
          stderr: 'ERROR: The Task Scheduler service is not available.',
        }
      }
      if (verb === '/Query' && !args.includes('/TN')) {
        const others = '"\\Microsoft\\Windows\\Other\\Task","N/A","Ready"\r\n'
        const ours = registered === undefined ? '' : `"${TASK_NAME}","N/A","Ready"\r\n`
        return { code: 0, stdout: `${others}${ours}`, stderr: '' }
      }
      if (verb === '/Query' && registered === undefined) {
        return { code: 1, stdout: '', stderr: 'ERROR: The system cannot find the file specified.' }
      }
      if (verb === '/Query' && args.includes('/XML'))
        return { code: 0, stdout: registered!, stderr: '' }
      if (verb === '/Query') {
        return {
          code: 0,
          stdout: `"HOST","${TASK_NAME}","N/A","Ready","Interactive only","N/A","267011","N/A","x"\r\n`,
          stderr: '',
        }
      }
      if (verb === '/Create') {
        registered = written.at(-1)!.data.toString('utf16le').slice(1)
        health = () => true
        return { code: 0, stdout: 'SUCCESS', stderr: '' }
      }
      if (verb === '/Run') {
        health = () => true
        return { code: 0, stdout: 'SUCCESS', stderr: '' }
      }
      if (verb === '/Delete') {
        registered = undefined
        return { code: 0, stdout: 'SUCCESS', stderr: '' }
      }
      if (verb === '/End') {
        if (!options.otherServer) health = () => false
        return { code: 0, stdout: 'SUCCESS', stderr: '' }
      }
    }
    if (file === 'powershell.exe') {
      const pids = (pidQueue.length > 1 ? pidQueue.shift() : pidQueue[0]) ?? []
      return { code: 0, stdout: pids.map(String).join('\r\n'), stderr: '' }
    }
    if (file === 'taskkill.exe') return { code: 0, stdout: 'SUCCESS', stderr: '' }
    throw new Error(`unexpected command ${file} ${args.join(' ')}`)
  }
  const deps: ServiceCommandDeps = {
    entry: ENTRY,
    platform: 'win32',
    env: { USERDOMAIN: 'MACHINE', USERNAME: 'ada', SystemRoot: 'C:\\Windows' },
    execPath: NODE,
    run,
    writeTempFile: async (name, data) => {
      written.push({ name, data })
      return `C:\\Temp\\${name}`
    },
    removeFile: async (path) => void removed.push(path),
    ensureDir: async (path) => void dirs.push(path),
    fetch: (async (input: string | URL | Request) => {
      if (!health()) throw new Error('ECONNREFUSED')
      return new Response(JSON.stringify({ status: 'ok' }), {
        status: String(input).endsWith('/health') ? 200 : 404,
      })
    }) as typeof fetch,
    sleep: async (ms) => void (clock += ms),
    now: () => clock,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  }
  return {
    deps,
    calls,
    out,
    err,
    written,
    removed,
    dirs,
    get registered() {
      return registered
    },
  }
}

describe('service commands', () => {
  it('refuses to run anywhere but Windows, before touching the system', async () => {
    const system = fakeSystem({})
    const code = await runServiceCommand(['install'], { ...system.deps, platform: 'linux' })
    expect(code).toBe(1)
    expect(system.err[0]).toContain('only run on Windows')
    expect(system.calls).toEqual([])
  })

  it('prints usage for no command or --help and rejects unknown commands', async () => {
    const system = fakeSystem({})
    expect(await runServiceCommand([], system.deps)).toBe(1)
    expect(await runServiceCommand(['--help'], system.deps)).toBe(0)
    expect(system.out.filter((line) => line.startsWith('Usage:'))).toHaveLength(2)
    expect(await runServiceCommand(['restart'], system.deps)).toBe(1)
    expect(system.err[0]).toContain('Unknown service command')
    expect(system.calls).toEqual([])
  })

  it('install registers the task from an XML file, starts it and waits for /health', async () => {
    const system = fakeSystem({})
    // loadConfig resolves paths with the host's path module, so the expected
    // values go through the same resolution to keep this test portable.
    const dataDir = resolve(DATA_DIR)
    const workspace = resolve('C:\\src\\repo')
    const code = await runServiceCommand(
      ['install', '--port', '43121', '--data-dir', DATA_DIR, '--workspace', 'C:\\src\\repo'],
      system.deps,
    )
    expect(system.err).toEqual([])
    expect(code).toBe(0)
    expect(system.calls.map((call) => call.slice(0, 2))).toEqual([
      ['schtasks.exe', '/Query'],
      ['schtasks.exe', '/Create'],
      ['schtasks.exe', '/Run'],
    ])
    const create = system.calls[1]!
    expect(create).toEqual([
      'schtasks.exe',
      '/Create',
      '/TN',
      TASK_NAME,
      '/XML',
      `C:\\Temp\\${system.written[0]!.name}`,
      '/F',
    ])
    expect(system.removed).toEqual([`C:\\Temp\\${system.written[0]!.name}`])
    expect(system.dirs).toEqual([dataDir])

    const xml = system.registered!
    expect(xml).toContain('<UserId>MACHINE\\ada</UserId>')
    expect(xml).toContain('<Command>C:\\Windows\\System32\\conhost.exe</Command>')
    const argv = parseWindowsCommandLine(readTaskArguments(xml) ?? '')
    expect(argv).toEqual([
      '--headless',
      NODE,
      ENTRY,
      '--port',
      '43121',
      '--data-dir',
      dataDir,
      '--log-level',
      'info',
      '--workspace',
      workspace,
      '--log-file',
      defaultLogFile(dataDir),
      '--exit-with-parent',
    ])
    expect(system.out.at(-1)).toBe('Environment server is up at http://127.0.0.1:43121.')
  })

  it('install surfaces a Task Scheduler query failure instead of treating it as not installed', async () => {
    const system = fakeSystem({ queryFails: true })
    expect(await runServiceCommand(['install', '--port', '43121'], system.deps)).toBe(1)
    expect(system.err[0]).toContain('Task Scheduler could not be queried')
    expect(system.calls.map((call) => call[1])).toEqual(['/Query'])

    const uninstall = fakeSystem({ queryFails: true })
    expect(await runServiceCommand(['uninstall'], uninstall.deps)).toBe(1)
    expect(uninstall.out).toEqual([])
    expect(uninstall.calls.map((call) => call[1])).toEqual(['/Query'])
  })

  it('a replacement install checks the target port after the old server is stopped', async () => {
    const existing = buildTaskXml({
      userId: 'MACHINE\\ada',
      command: 'conhost.exe',
      arguments: ['--headless', NODE, ENTRY, '--port', '43120', '--exit-with-parent']
        .map(quoteWindowsArgument)
        .join(' '),
      workingDirectory: DATA_DIR,
    })
    const system = fakeSystem({
      registered: existing,
      healthy: () => true,
      otherServer: true,
      pids: [[4242], []],
    })
    expect(await runServiceCommand(['install', '--port', '43120'], system.deps)).toBe(1)
    expect(system.err[0]).toContain('already answers on http://127.0.0.1:43120')
    expect(system.calls.map((call) => call[1])).not.toContain('/Create')
  })

  it('install rejects a dynamic port, remint, and a port another process already answers on', async () => {
    const dynamic = fakeSystem({})
    expect(await runServiceCommand(['install', '--port', '0'], dynamic.deps)).toBe(1)
    expect(dynamic.err[0]).toContain('fixed --port')

    const remint = fakeSystem({})
    expect(await runServiceCommand(['install', '--remint-owner'], remint.deps)).toBe(1)
    expect(remint.err[0]).toContain('--remint-owner')

    const busy = fakeSystem({ healthy: () => true })
    expect(await runServiceCommand(['install', '--port', '43120'], busy.deps)).toBe(1)
    expect(busy.err[0]).toContain('already answers on http://127.0.0.1:43120')
    expect(busy.calls.map((call) => call[1])).toEqual(['/Query'])

    const invalid = fakeSystem({})
    expect(await runServiceCommand(['install', '--port', 'abc'], invalid.deps)).toBe(1)
    expect(invalid.err[0]).toContain('Port must be')
  })

  it('install replaces an existing task after stopping the old server', async () => {
    const existing = buildTaskXml({
      userId: 'MACHINE\\ada',
      command: 'conhost.exe',
      arguments: ['--headless', NODE, ENTRY, '--port', '43120', '--exit-with-parent']
        .map(quoteWindowsArgument)
        .join(' '),
      workingDirectory: DATA_DIR,
    })
    const system = fakeSystem({ registered: existing, pids: [[4242], []] })
    const code = await runServiceCommand(['install', '--port', '43122'], system.deps)
    expect(system.err).toEqual([])
    expect(code).toBe(0)
    expect(system.calls.map((call) => `${call[0]} ${call[1]}`)).toEqual([
      'schtasks.exe /Query',
      'schtasks.exe /Query',
      'schtasks.exe /End',
      'powershell.exe -NoProfile',
      'powershell.exe -NoProfile',
      'schtasks.exe /Create',
      'schtasks.exe /Run',
    ])
    expect(system.out[0]).toBe('Replacing the existing logon task.')
  })

  it('uninstall stops the server, force-kills a straggler, and deletes the task', async () => {
    const existing = buildTaskXml({
      userId: 'MACHINE\\ada',
      command: 'conhost.exe',
      arguments: ['--headless', NODE, ENTRY, '--port', '43120', '--data-dir', DATA_DIR]
        .map(quoteWindowsArgument)
        .join(' '),
      workingDirectory: DATA_DIR,
    })
    // The straggler never leaves on its own: every lookup keeps returning it.
    const system = fakeSystem({ registered: existing, pids: [[777]] })
    const code = await runServiceCommand(['uninstall'], system.deps)
    expect(system.err).toEqual([])
    expect(code).toBe(0)
    expect(system.calls).toContainEqual(['taskkill.exe', '/PID', '777', '/T', '/F'])
    expect(system.calls.at(-1)).toEqual(['schtasks.exe', '/Delete', '/TN', TASK_NAME, '/F'])
    expect(system.registered).toBeUndefined()
    expect(system.out[0]).toContain('Stopped the environment server and removed')
    expect(system.out[1]).toContain(DATA_DIR)
  })

  it('uninstall is idempotent when nothing is registered', async () => {
    const system = fakeSystem({})
    expect(await runServiceCommand(['uninstall'], system.deps)).toBe(0)
    expect(system.out[0]).toContain('nothing to remove')
    expect(system.calls.map((call) => call[1])).toEqual(['/Query'])
  })

  it('status reports not installed, or the task state plus whether /health answers', async () => {
    const missing = fakeSystem({})
    expect(await runServiceCommand(['status'], missing.deps)).toBe(1)
    expect(missing.out[0]).toContain('Not installed')

    const existing = buildTaskXml({
      userId: 'MACHINE\\ada',
      command: 'conhost.exe',
      arguments: [
        '--headless',
        NODE,
        ENTRY,
        '--port',
        '43120',
        '--data-dir',
        DATA_DIR,
        '--log-file',
        'C:\\logs\\server.log',
      ]
        .map(quoteWindowsArgument)
        .join(' '),
      workingDirectory: DATA_DIR,
    })
    const down = fakeSystem({ registered: existing })
    expect(await runServiceCommand(['status'], down.deps)).toBe(1)
    expect(down.out).toEqual([
      `Task:      ${TASK_NAME} (Ready)`,
      'Last run:  N/A, result 267011 (has not run yet)',
      'Server:    http://127.0.0.1:43120 (not answering)',
      `Data dir:  ${DATA_DIR}`,
      'Log file:  C:\\logs\\server.log',
    ])

    const up = fakeSystem({ registered: existing, healthy: () => true })
    expect(await runServiceCommand(['status'], up.deps)).toBe(0)
    expect(up.out[2]).toBe('Server:    http://127.0.0.1:43120 (answering /health)')
  })

  it('start and stop need a registered task; start is a no-op when already healthy', async () => {
    const none = fakeSystem({})
    expect(await runServiceCommand(['start'], none.deps)).toBe(1)
    expect(none.err[0]).toContain('service install')
    expect(await runServiceCommand(['stop'], none.deps)).toBe(1)

    const existing = buildTaskXml({
      userId: 'MACHINE\\ada',
      command: 'conhost.exe',
      arguments: ['--headless', NODE, ENTRY, '--port', '43120'].map(quoteWindowsArgument).join(' '),
      workingDirectory: DATA_DIR,
    })
    const system = fakeSystem({ registered: existing, pids: [[4242], []] })
    expect(await runServiceCommand(['start'], system.deps)).toBe(0)
    expect(system.out.at(-1)).toBe('Environment server is up at http://127.0.0.1:43120.')
    expect(await runServiceCommand(['start'], system.deps)).toBe(0)
    expect(system.out.at(-1)).toContain('already up')
    expect(await runServiceCommand(['stop'], system.deps)).toBe(0)
    expect(system.out.at(-1)).toContain('Stopped the environment server')
    expect(await runServiceCommand(['stop', 'now'], system.deps)).toBe(1)
    expect(system.err.at(-1)).toContain('takes no arguments')
  })
})
