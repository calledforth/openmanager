import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  defaultLogFile,
  runServiceCommand,
  type RunResult,
  type ServiceCommandDeps,
} from '../src/service/cli.js'
import { flagValue } from '../src/service/server-arguments.js'
import {
  buildTaskXml,
  encodeTaskXml,
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
const TUNNEL_TOKEN = 'eyJhIjoiYWNjb3VudCIsInQiOiJ0dW5uZWwiLCJzIjoic2VjcmV0In0'

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
      '--supervise',
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
  /** The PowerShell process lookup fails. */
  endFails?: boolean
  killFails?: boolean
  lastResult?: string
  processQueryFails?: boolean
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
          stdout: `"HOST","${TASK_NAME}","N/A","Ready","Interactive only","N/A","${options.lastResult ?? '267011'}","N/A","x"\r\n`,
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
        if (options.endFails) return { code: 1, stdout: '', stderr: 'Access denied' }
        if (!options.otherServer) health = () => false
        return { code: 0, stdout: 'SUCCESS', stderr: '' }
      }
    }
    if (file === 'powershell.exe') {
      if (options.processQueryFails) {
        return { code: 1, stdout: '', stderr: 'Get-CimInstance : Access denied' }
      }
      const pids = (pidQueue.length > 1 ? pidQueue.shift() : pidQueue[0]) ?? []
      const taskArgs = parseWindowsCommandLine(readTaskArguments(registered!) ?? '').slice(1)
      if (!taskArgs.includes('--exit-with-parent')) taskArgs.push('--exit-with-parent')
      return {
        code: 0,
        stdout: JSON.stringify(
          pids.map((ProcessId) => ({
            ProcessId,
            CommandLine: taskArgs.map(quoteWindowsArgument).join(' '),
          })),
        ),
        stderr: '',
      }
    }
    if (file === 'taskkill.exe') {
      if (options.killFails) return { code: 1, stdout: '', stderr: 'Access denied' }
      pidQueue.splice(0, pidQueue.length, [])
      return { code: 0, stdout: 'SUCCESS', stderr: '' }
    }
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
  it('refuses platforms without a supported supervisor, before touching the system', async () => {
    const system = fakeSystem({})
    const code = await runServiceCommand(['install'], { ...system.deps, platform: 'darwin' })
    expect(code).toBe(1)
    expect(system.err[0]).toContain('not darwin')
    expect(system.calls).toEqual([])
  })

  it('prints usage for no command or --help and rejects unknown commands', async () => {
    const system = fakeSystem({})
    expect(await runServiceCommand([], system.deps)).toBe(1)
    expect(await runServiceCommand(['--help'], system.deps)).toBe(0)
    expect(system.out.filter((line) => line.startsWith('Usage:'))).toHaveLength(2)
    expect(await runServiceCommand(['invalid'], system.deps)).toBe(1)
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
      '--supervise',
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

  it('install keeps the tunnel token in the data directory, never in the task', async () => {
    const binDir = mkdtempSync(join(tmpdir(), 'openmanager-service-cloudflared-'))
    try {
      const cloudflared = join(binDir, 'cloudflared.exe')
      writeFileSync(cloudflared, '')
      const system = fakeSystem({})
      const secrets: { path: string; text: string }[] = []
      const dataDir = resolve(DATA_DIR)
      const code = await runServiceCommand(
        [
          'install',
          '--port',
          '43121',
          '--data-dir',
          DATA_DIR,
          '--tunnel-hostname',
          'om.example.com',
          '--cloudflared',
          cloudflared,
        ],
        {
          ...system.deps,
          env: { ...system.deps.env, OPENMANAGER_TUNNEL_TOKEN: TUNNEL_TOKEN },
          writeSecretFile: async (path, text) => void secrets.push({ path, text }),
        },
      )
      expect(system.err).toEqual([])
      expect(code).toBe(0)
      const tokenFile = join(dataDir, 'tunnel-token')
      expect(secrets).toEqual([{ path: tokenFile, text: `${TUNNEL_TOKEN}\n` }])
      const xml = system.registered!
      expect(xml).not.toContain(TUNNEL_TOKEN)
      const argv = parseWindowsCommandLine(readTaskArguments(xml) ?? '')
      expect(flagValue(argv, '--tunnel-hostname')).toBe('om.example.com')
      expect(flagValue(argv, '--tunnel-token-file')).toBe(tokenFile)
      expect(flagValue(argv, '--cloudflared')).toBe(cloudflared)
      expect(system.out.join('\n')).not.toContain(TUNNEL_TOKEN)
      expect(system.out).toContain(`  Tunnel:    token saved to ${tokenFile}`)

      // Without a token in the environment, the file must already hold one.
      const noToken = fakeSystem({})
      const args = ['install', '--port', '43121', '--data-dir', DATA_DIR]
      const tunnelArgs = ['--tunnel-hostname', 'om.example.com', '--cloudflared', cloudflared]
      expect(
        await runServiceCommand([...args, ...tunnelArgs], {
          ...noToken.deps,
          readFile: async () => undefined,
        }),
      ).toBe(1)
      expect(noToken.err[0]).toContain('No tunnel token in')
      expect(noToken.calls.map((call) => call[1])).not.toContain('/Create')
      const saved = fakeSystem({})
      expect(
        await runServiceCommand([...args, ...tunnelArgs], {
          ...saved.deps,
          readFile: async (path) => (path === tokenFile ? `${TUNNEL_TOKEN}\n` : undefined),
        }),
      ).toBe(0)

      // No cloudflared on PATH and none named: nothing is registered.
      const noBinary = fakeSystem({})
      expect(
        await runServiceCommand([...args, '--tunnel-hostname', 'om.example.com'], {
          ...noBinary.deps,
          env: {
            ...noBinary.deps.env,
            OPENMANAGER_TUNNEL_TOKEN: TUNNEL_TOKEN,
            PATH: binDir + '-none',
          },
        }),
      ).toBe(1)
      expect(noBinary.err[0]).toContain('cloudflared is not on PATH')
    } finally {
      rmSync(binDir, { recursive: true, force: true })
    }
  })

  it('status shows the tunnel state the server published', async () => {
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
        '--tunnel-hostname',
        'om.example.com',
      ]
        .map(quoteWindowsArgument)
        .join(' '),
      workingDirectory: DATA_DIR,
    })
    const status = {
      state: 'self_check_failed',
      hostname: 'om.example.com',
      reason: 'other_environment',
      since: '2026-10-06T10:00:00.000Z',
      restarts: 0,
    }
    const read = async (path: string) =>
      path === join(DATA_DIR, 'tunnel-status.json') ? JSON.stringify(status) : undefined
    const up = fakeSystem({ registered: existing, healthy: () => true, pids: [[4242]] })
    expect(await runServiceCommand(['status'], { ...up.deps, readFile: read })).toBe(0)
    expect(up.out).toContain(
      'Tunnel:    https://om.example.com (self check failed: other environment since 2026-10-06T10:00:00.000Z)',
    )
    const json = fakeSystem({ registered: existing, healthy: () => true, pids: [[4242]] })
    await runServiceCommand(['status', '--json'], { ...json.deps, readFile: read })
    expect(JSON.parse(json.out[0]!)).toMatchObject({
      tunnelHostname: 'om.example.com',
      tunnel: { state: 'self_check_failed' },
    })
    const down = fakeSystem({ registered: existing })
    await runServiceCommand(['status'], { ...down.deps, readFile: read })
    expect(down.out).toContain('Tunnel:    https://om.example.com (unknown; server not up)')
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
      'State:     stopped',
    ])

    const up = fakeSystem({ registered: existing, healthy: () => true, pids: [[4242]] })
    expect(await runServiceCommand(['status'], up.deps)).toBe(0)
    expect(up.out[2]).toBe('Server:    http://127.0.0.1:43120 (answering /health)')

    // Something else holds the port while the task's server is not running.
    const foreign = fakeSystem({ registered: existing, healthy: () => true })
    expect(await runServiceCommand(['status'], foreign.deps)).toBe(1)
    expect(foreign.out[2]).toBe(
      'Server:    http://127.0.0.1:43120 (answering /health, but not from the logon task)',
    )
  })

  it('a failed process lookup falls back to /health instead of blaming another server', async () => {
    const existing = buildTaskXml({
      userId: 'MACHINE\\ada',
      command: 'conhost.exe',
      arguments: ['--headless', NODE, ENTRY, '--port', '43120'].map(quoteWindowsArgument).join(' '),
      workingDirectory: DATA_DIR,
    })
    const system = fakeSystem({
      registered: existing,
      healthy: () => true,
      processQueryFails: true,
    })
    expect(await runServiceCommand(['start'], system.deps)).toBe(0)
    expect(system.out.at(-1)).toContain('already up')
    expect(await runServiceCommand(['status'], system.deps)).toBe(1)
    expect(system.out).toContain(
      "Server:    http://127.0.0.1:43120 (answering /health; could not confirm it is the logon task's server)",
    )
    expect(system.err).toEqual([])
  })

  it('start refuses when another server answers on the task port', async () => {
    const existing = buildTaskXml({
      userId: 'MACHINE\\ada',
      command: 'conhost.exe',
      arguments: ['--headless', NODE, ENTRY, '--port', '43120'].map(quoteWindowsArgument).join(' '),
      workingDirectory: DATA_DIR,
    })
    const system = fakeSystem({ registered: existing, healthy: () => true })
    expect(await runServiceCommand(['start'], system.deps)).toBe(1)
    expect(system.err[0]).toContain('Something other than the logon task answers')
    expect(system.calls.map((call) => call[1])).not.toContain('/Run')
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
    // Lookups: the second start sees the server, stop sees it once, then it is gone.
    const system = fakeSystem({ registered: existing, pids: [[4242], [4242], []] })
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

const LIFECYCLE_TASK = buildTaskXml({
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
    '--exit-with-parent',
  ]
    .map(quoteWindowsArgument)
    .join(' '),
  workingDirectory: DATA_DIR,
})

describe('service maintenance', () => {
  it('updates to a new build after shutdown without changing installed settings', async () => {
    const original = LIFECYCLE_TASK.replace(
      '--exit-with-parent',
      '--allowed-origin https://example.com --log-level debug --workspace C:\\repo --exit-with-parent',
    )
    const system = fakeSystem({ registered: original, healthy: () => true, pids: [[42], []] })
    system.deps.entry = 'C:\\new build & release\\main.js'
    system.deps.execPath = 'C:\\new node\\node.exe'
    system.deps.env = { OPENMANAGER_DATA_DIR: 'C:\\wrong', OPENMANAGER_PORT: '9999' }
    expect(await runServiceCommand(['update'], system.deps)).toBe(0)
    const before = parseWindowsCommandLine(readTaskArguments(original)!)
    const after = parseWindowsCommandLine(readTaskArguments(system.registered!)!)
    expect(after).toEqual([
      '--headless',
      system.deps.execPath,
      system.deps.entry,
      '--supervise',
      ...before.slice(3),
    ])
    expect(system.registered!.replace(/<Arguments>[\s\S]*?<\/Arguments>/, '')).toBe(
      original.replace(/<Arguments>[\s\S]*?<\/Arguments>/, ''),
    )
    const verbs = system.calls.map((call) => call[1])
    expect(verbs.indexOf('/End')).toBeLessThan(verbs.indexOf('/Create'))
    expect(verbs.indexOf('/Create')).toBeLessThan(verbs.indexOf('/Run'))
    expect(system.calls.some((call) => call[0] === 'taskkill.exe')).toBe(false)
    expect(system.dirs).toEqual([])
  })

  it.each([
    { endFails: true },
    { processQueryFails: true },
    { killFails: true, pids: [[42]] },
    { otherServer: true, healthy: () => true },
  ])('retains the old build when update cannot confirm shutdown: %j', async (failure) => {
    const system = fakeSystem({ registered: LIFECYCLE_TASK, ...failure })
    expect(await runServiceCommand(['update'], system.deps)).toBe(1)
    expect(system.registered).toBe(LIFECYCLE_TASK)
    expect(system.written).toEqual([])
    expect(system.calls.some((call) => call[1] === '/Run')).toBe(false)
  })

  it('rejects an unsupported update before stopping and rejects configuration overrides', async () => {
    const system = fakeSystem({ registered: LIFECYCLE_TASK.replace('--headless', '--unknown') })
    expect(await runServiceCommand(['update'], system.deps)).toBe(1)
    expect(system.calls.some((call) => call[1] === '/End')).toBe(false)
    expect(await runServiceCommand(['update', '--data-dir', 'elsewhere'], system.deps)).toBe(1)
    const missing = fakeSystem({})
    expect(await runServiceCommand(['update'], missing.deps)).toBe(1)
    expect(missing.err[0]).toContain('install')
  })

  it('restart stops before starting and keeps the installed definition and credentials', async () => {
    const system = fakeSystem({ registered: LIFECYCLE_TASK, healthy: () => true, pids: [[42], []] })
    expect(await runServiceCommand(['restart'], system.deps)).toBe(0)
    const verbs = system.calls.map((call) => call[1])
    expect(verbs.indexOf('/End')).toBeLessThan(verbs.indexOf('/Run'))
    expect(system.registered).toBe(LIFECYCLE_TASK)
    expect(system.removed).toEqual([])
    expect(system.written).toEqual([])
  })

  it.each(['restart', 'uninstall'])(
    '%s refuses to continue after a failed process lookup or kill',
    async (command) => {
      for (const failure of [{ processQueryFails: true }, { killFails: true, pids: [[42]] }]) {
        const system = fakeSystem({ registered: LIFECYCLE_TASK, ...failure })
        expect(await runServiceCommand([command], system.deps)).toBe(1)
        expect(system.registered).toBe(LIFECYCLE_TASK)
        expect(system.calls.map((call) => call[1])).not.toContain('/Run')
        expect(system.calls.map((call) => call[1])).not.toContain('/Delete')
        expect(system.removed).toEqual([])
      }
    },
  )

  it('restart refuses a foreign server after stopping the task', async () => {
    const system = fakeSystem({
      registered: LIFECYCLE_TASK,
      healthy: () => true,
      otherServer: true,
      pids: [[42], []],
    })
    expect(await runServiceCommand(['restart'], system.deps)).toBe(1)
    expect(system.calls.map((call) => call[1])).not.toContain('/Run')
  })

  it.each([
    { pids: [[42]], lastResult: '267009', healthy: () => true, state: 'running', code: 0 },
    { pids: [], lastResult: '0', state: 'stopped', code: 1 },
    { pids: [], lastResult: '1', state: 'failed', code: 1 },
    { pids: [], processQueryFails: true, state: 'unknown', code: 1 },
  ])('reports $state as JSON without credentials', async (options) => {
    const system = fakeSystem({ registered: LIFECYCLE_TASK, ...options })
    expect(await runServiceCommand(['status', '--json'], system.deps)).toBe(options.code)
    expect(system.out).toHaveLength(1)
    expect(JSON.parse(system.out[0]!)).toMatchObject({
      installed: true,
      state: options.state,
      dataDir: DATA_DIR,
    })
  })

  it('tails the installed path and validates options before querying the supervisor', async () => {
    const system = fakeSystem({ registered: LIFECYCLE_TASK })
    const tails: unknown[] = []
    const deps = {
      ...system.deps,
      tailLogs: async (path: string, options: unknown) => {
        tails.push({ path, options })
      },
    }
    expect(await runServiceCommand(['logs', '--lines', '-1'], deps)).toBe(1)
    expect(system.calls).toEqual([])
    expect(await runServiceCommand(['logs', '-f', '-n', '20'], deps)).toBe(0)
    expect(tails).toEqual([{ path: 'C:\\logs\\server.log', options: { follow: true, lines: 20 } }])
  })
})

describe('shutdown confirmation regressions', () => {
  it.each(['restart', 'uninstall'])(
    '%s refuses a failed task end even before Node starts',
    async (command) => {
      const system = fakeSystem({ registered: LIFECYCLE_TASK, endFails: true, pids: [] })
      expect(await runServiceCommand([command], system.deps)).toBe(1)
      expect(system.err[0]).toContain('could not end the task')
      expect(system.registered).toBe(LIFECYCLE_TASK)
      expect(system.calls.map((call) => call[1])).not.toContain('/Run')
      expect(system.calls.map((call) => call[1])).not.toContain('/Delete')
    },
  )

  it('restart rejects a healthy occupied port even if a later ownership query would fail', async () => {
    const system = fakeSystem({
      registered: LIFECYCLE_TASK,
      healthy: () => true,
      otherServer: true,
    })
    let lookups = 0
    const run = system.deps.run!
    system.deps.run = async (file, args) => {
      if (file === 'powershell.exe' && ++lookups > 1)
        return { code: 1, stdout: '', stderr: 'Access denied' }
      return run(file, args)
    }
    expect(await runServiceCommand(['restart'], system.deps)).toBe(1)
    expect(system.err[0]).toContain('Something other than')
    expect(system.calls.map((call) => call[1])).not.toContain('/Run')
    expect(system.out.join(' ')).not.toContain('already up')
  })
})
