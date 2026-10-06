import { spawn as spawnProcess } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { startServer } from '../src/server.js'
import {
  cloudflaredArgs,
  cloudflaredEnvironment,
  ingressIsShared,
  locateCloudflared,
  TUNNEL_STATUS_FILE_NAME,
  validateTunnelHostname,
  type TunnelState,
  type TunnelStatus,
  type TunnelTiming,
} from '../src/tunnel.js'

const FAKE = fileURLToPath(new URL('./fixtures/fake-cloudflared.mjs', import.meta.url))
const HOSTNAME = 'om.test'
const TOKEN = 'eyJhIjoiZmFrZS1hY2NvdW50IiwidCI6ImZha2UtdHVubmVsIiwicyI6ImZha2Utc2VjcmV0In0'

const FAST: Partial<TunnelTiming> = {
  pollMs: 50,
  probeTimeoutMs: 1_000,
  startTimeoutMs: 5_000,
  unreadyRestartMs: 60_000,
  clockJumpMs: 30_000,
  restartMinMs: 50,
  restartMaxMs: 300,
  stableMs: 60_000,
  selfCheckTimeoutMs: 2_000,
  selfCheckRetryMinMs: 100,
  selfCheckRetryMaxMs: 400,
  selfCheckIntervalMs: 60_000,
  stopTimeoutMs: 2_000,
}

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function tempDir(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** The fake connector under the name the supervisor looks for, as the path override points at it. */
async function installFake() {
  const dir = await tempDir('openmanager-cloudflared-')
  const binary = join(dir, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared')
  copyFileSync(FAKE, binary)
  chmodSync(binary, 0o755)
  return { dir, binary }
}

/**
 * Self-check fetch: `https://om.test/...` goes to whatever `target()` names,
 * with `Host: om.test` as Cloudflare would send it, so the Host allowlist is
 * exercised. Everything else (the metrics server) is a normal fetch.
 */
type Target = { port: number } | { status: number; body: unknown }

function tunnelFetch(target: () => Target | Promise<Target>) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.protocol !== 'https:') return fetch(input, init)
    const to = await target()
    if ('status' in to) return new Response(JSON.stringify(to.body), { status: to.status })
    return new Promise<Response>((resolveResponse, reject) => {
      const outgoing = httpRequest(
        {
          host: '127.0.0.1',
          port: to.port,
          path: url.pathname,
          headers: { host: url.host, 'cf-connecting-ip': '203.0.113.9', 'cf-ray': 'fake' },
        },
        (incoming) => {
          const chunks: Buffer[] = []
          incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
          incoming.on('end', () =>
            resolveResponse(
              new Response(Buffer.concat(chunks), { status: incoming.statusCode ?? 500 }),
            ),
          )
        },
      )
      outgoing.on('error', reject)
      outgoing.end()
    })
  }) as typeof fetch
}

async function freePort() {
  const probe = createServer()
  await new Promise<void>((resolveListen) => probe.listen(0, '127.0.0.1', resolveListen))
  const { port } = probe.address() as AddressInfo
  await new Promise((resolveClose) => probe.close(resolveClose))
  return port
}

interface HostOptions {
  binary?: string
  mode?: string
  token?: string | null
  target?: () => Target | Promise<Target>
  timing?: Partial<TunnelTiming>
  now?: () => number
  ingress?: unknown
}

async function startTunnelHost(options: HostOptions = {}) {
  const dataDir = await tempDir('openmanager-tunnel-test-')
  const fake = options.binary === undefined ? await installFake() : undefined
  const record = join(dataDir, 'fake-record.jsonl')
  const logFile = join(dataDir, 'server.log')
  const spawned: string[] = []
  // Known before the server starts, so the fake's ingress can name it.
  const serverPort = await freePort()
  const server = await startServer({
    port: serverPort,
    dataDir,
    logLevel: 'debug',
    logFile,
    tunnel: {
      hostname: HOSTNAME,
      tokenFile: join(dataDir, 'tunnel-token'),
      ...(options.token === null ? {} : { token: options.token ?? TOKEN }),
      cloudflared: options.binary ?? fake!.binary,
    },
    tunnelOptions: {
      timing: { ...FAST, ...options.timing },
      ...(options.now ? { now: options.now } : {}),
      env: {
        ...process.env,
        TUNNEL_URL: 'http://evil.example',
        TUNNEL_LOGLEVEL: 'debug',
        ANTHROPIC_API_KEY: 'provider-key',
      },
      fetch: tunnelFetch(options.target ?? (() => ({ port: serverPort }))),
      // The supervisor resolves and checks the path override; the placeholder
      // there stands in for the binary, and this Node runs the fake script.
      spawn: (file, args, spawnOptions) => {
        spawned.push(file)
        return spawnProcess(process.execPath, [FAKE, ...args], {
          ...spawnOptions,
          env: {
            ...spawnOptions.env,
            FAKE_CLOUDFLARED_RECORD: record,
            FAKE_CLOUDFLARED_MODE: options.mode ?? 'ok',
            FAKE_CLOUDFLARED_ORIGIN: String(serverPort),
            ...(options.ingress
              ? { FAKE_CLOUDFLARED_INGRESS: JSON.stringify(options.ingress) }
              : {}),
          },
        })
      },
    },
  })
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await server.close()
  }
  cleanups.push(close)
  const records = () =>
    existsSync(record)
      ? readFileSync(record, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map(
            (line) =>
              JSON.parse(line) as {
                pid: number
                argv: string[]
                token: string
                env: string[]
                metricsPort: number
              },
          )
      : []
  const fakeOrder = async (order: 'unready' | 'ready' | 'exit' | 'reconfigure') => {
    const last = records().at(-1)!
    await fetch(`http://127.0.0.1:${last.metricsPort}/fake/${order}`)
  }
  return { server, dataDir, logFile, records, fakeOrder, spawned, close }
}

async function waitFor<T>(
  read: () => T | undefined | false,
  what: string,
  timeoutMs = 8_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((resolveWait) => setTimeout(resolveWait, 20))
  }
}

const stateOf = (host: Awaited<ReturnType<typeof startTunnelHost>>) => host.server.tunnel!.status()
const waitForState = (
  host: Awaited<ReturnType<typeof startTunnelHost>>,
  state: TunnelState,
  timeoutMs?: number,
  extra: (status: TunnelStatus) => boolean = () => true,
) =>
  waitFor(
    () => {
      const status = stateOf(host)
      return status.state === state && extra(status) && status
    },
    `tunnel ${state} (now ${JSON.stringify(stateOf(host))})`,
    timeoutMs,
  )

function hostRequest(port: number, path: string, headers: Record<string, string>) {
  return new Promise<number>((resolveStatus, reject) => {
    const outgoing = httpRequest({ host: '127.0.0.1', port, path, headers }, (incoming) => {
      incoming.resume()
      resolveStatus(incoming.statusCode ?? 0)
    })
    outgoing.on('error', reject)
    outgoing.end()
  })
}

function isAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('tunnel configuration', () => {
  it('takes the hostname, token file and binary from flags or the environment', () => {
    const dataDir = resolve('tunnel-data')
    const config = loadConfig(
      ['--data-dir', dataDir, '--tunnel-hostname', 'OM.Example.com', '--cloudflared', 'bin/cf'],
      { OPENMANAGER_TUNNEL_TOKEN: ` ${TOKEN}\n` },
    )
    expect(config.tunnel).toEqual({
      hostname: 'om.example.com',
      token: TOKEN,
      tokenFile: join(dataDir, 'tunnel-token'),
      cloudflared: resolve('bin/cf'),
    })
    expect(config.allowedHosts).toEqual([])
    expect(
      loadConfig([], {
        OPENMANAGER_TUNNEL_HOSTNAME: 'om.example.com',
        OPENMANAGER_TUNNEL_TOKEN_FILE: 'secret/token',
      }).tunnel,
    ).toEqual({ hostname: 'om.example.com', tokenFile: resolve('secret/token') })
  })

  it('runs no tunnel without a hostname and refuses tunnel flags that lack one', () => {
    expect(
      loadConfig([], { OPENMANAGER_TUNNEL_TOKEN: TOKEN, OPENMANAGER_CLOUDFLARED: '/x' }).tunnel,
    ).toBeUndefined()
    expect(() => loadConfig(['--cloudflared', '/usr/bin/cloudflared'], {})).toThrow(
      /need --tunnel-hostname/,
    )
    expect(() => loadConfig(['--tunnel-token-file', 'token'], {})).toThrow(/need --tunnel-hostname/)
  })

  it('accepts only a bare DNS hostname and a single-line token', () => {
    for (const bad of [
      'https://om.example.com',
      'om.example.com:443',
      'om.example.com/env',
      'localhost',
      '127.0.0.1',
      '*.example.com',
      'om..example.com',
    ]) {
      expect(() => validateTunnelHostname(bad), bad).toThrow(/bare DNS name/)
    }
    expect(validateTunnelHostname(' Om.Example.COM ')).toBe('om.example.com')
    expect(() =>
      loadConfig(['--tunnel-hostname', 'om.example.com'], {
        OPENMANAGER_TUNNEL_TOKEN: 'two words',
      }),
    ).toThrow(/single-line token/)
  })

  it('never puts the token on the connector command line', () => {
    const args = cloudflaredArgs('/data/cloudflared.yml')
    expect(args.join(' ')).not.toMatch(/token/i)
    expect(args).toContain('--no-autoupdate')
    expect(args).toEqual(expect.arrayContaining(['--loglevel', 'info']))
    // Pinned, so a leftover ~/.cloudflared/config.yml cannot add settings.
    expect(args.slice(0, 3)).toEqual(['tunnel', '--config', '/data/cloudflared.yml'])
    expect(args.at(-1)).toBe('run')
  })

  it('gives the connector only the environment it needs, plus the token', () => {
    const env = cloudflaredEnvironment(
      {
        Path: '/bin',
        HOME: '/home/ada',
        SystemRoot: 'C:\\Windows',
        HTTPS_PROXY: 'http://proxy:3128',
        LC_ALL: 'C',
        TUNNEL_URL: 'http://elsewhere',
        tunnel_loglevel: 'debug',
        NO_AUTOUPDATE: 'false',
        OPENMANAGER_LOCAL_OWNER_CLAIM_KEY: 'k',
        OPENMANAGER_TUNNEL_TOKEN: 'old',
        ANTHROPIC_API_KEY: 'sk-ant-secret',
        OPENAI_API_KEY: 'sk-secret',
      },
      TOKEN,
    )
    expect(env).toEqual({
      Path: '/bin',
      HOME: '/home/ada',
      SystemRoot: 'C:\\Windows',
      HTTPS_PROXY: 'http://proxy:3128',
      LC_ALL: 'C',
      TUNNEL_TOKEN: TOKEN,
    })
  })

  it('finds cloudflared on PATH, or exactly where it was pointed', async () => {
    const { dir, binary } = await installFake()
    const env = { Path: ['/nowhere', dir].join(process.platform === 'win32' ? ';' : ':') }
    expect(locateCloudflared(undefined, env)).toBe(binary)
    expect(locateCloudflared(undefined, { PATH: '/nowhere' })).toBeUndefined()
    // A relative PATH entry still yields an absolute path a service can use.
    expect(locateCloudflared(undefined, { PATH: relative(process.cwd(), dir) })).toBe(binary)
    expect(locateCloudflared(binary, {})).toBe(binary)
    expect(locateCloudflared(join(dir, 'missing'), env)).toBeUndefined()
    // On Windows a path without `.exe` names the executable.
    const bare = binary.replace(/\.exe$/, '')
    expect(locateCloudflared(bare, {}, 'win32')).toBe(
      process.platform === 'win32' ? binary : undefined,
    )
  })

  it('tells a tunnel that serves only this server from one that serves more', () => {
    const rules = (...services: string[]) => ({
      config: { ingress: services.map((service) => ({ service })) },
    })
    expect(ingressIsShared(rules('http://127.0.0.1:8791', 'http_status:404'), 8791)).toBe(false)
    expect(ingressIsShared(rules('http://localhost:8791'), 8791)).toBe(false)
    expect(ingressIsShared(rules('http://127.0.0.1:8791', 'http://127.0.0.1:3000'), 8791)).toBe(
      true,
    )
    expect(ingressIsShared(rules('ssh://127.0.0.1:22'), 8791)).toBe(true)
    expect(ingressIsShared(rules('http://192.168.1.4:8791'), 8791)).toBe(true)
    expect(ingressIsShared({ version: -1 }, 8791)).toBeUndefined()
  })
})

describe('tunnel supervisor', () => {
  it('starts the connector, checks the hostname and offers the route', async () => {
    const host = await startTunnelHost()
    const status = await waitForState(host, 'connected')
    expect(status).toMatchObject({
      hostname: HOSTNAME,
      route: `https://${HOSTNAME}`,
      restarts: 0,
      sharedIngress: false,
    })
    // The status a `service status` reads.
    const published = JSON.parse(
      readFileSync(join(host.dataDir, TUNNEL_STATUS_FILE_NAME), 'utf8'),
    ) as TunnelStatus
    expect(published).toMatchObject({ state: 'connected', route: `https://${HOSTNAME}` })

    // The token reached the connector in its environment, and nowhere else.
    const [started] = host.records()
    expect(started!.token).toBe(TOKEN)
    expect(started!.argv.join(' ')).not.toContain(TOKEN)
    expect(started!.argv).toEqual(cloudflaredArgs(join(host.dataDir, 'cloudflared.yml')))
    expect(readFileSync(join(host.dataDir, 'cloudflared.yml'), 'utf8')).toContain(
      'no-autoupdate: true',
    )
    expect(started!.env.filter((name) => /^(TUNNEL_|OPENMANAGER_)/i.test(name))).toEqual([
      'TUNNEL_TOKEN',
    ])
    expect(started!.env).not.toContain('ANTHROPIC_API_KEY')
    expect(host.spawned).toHaveLength(1)
    expect(host.spawned[0]).toMatch(/cloudflared(\.exe)?$/)

    // The tunnel host is allowed; the local-owner route still hides behind it.
    expect(await hostRequest(host.server.port, '/health', { host: HOSTNAME })).toBe(200)
    expect(await hostRequest(host.server.port, '/health', { host: 'other.test' })).toBe(403)
    expect(await hostRequest(host.server.port, '/local-owner', { host: HOSTNAME })).toBe(404)
    expect(
      await hostRequest(host.server.port, '/local-owner', {
        host: `127.0.0.1:${host.server.port}`,
        'cf-connecting-ip': '203.0.113.9',
      }),
    ).toBe(404)

    const pid = started!.pid
    await host.close()
    expect(isAlive(pid)).toBe(false)
    expect(stateOf(host).state).toBe('stopped')
    const log = readFileSync(host.logFile, 'utf8')
    expect(log).not.toContain(TOKEN)
    expect(log).toContain('Settings: map[token:[redacted]]')
    expect(log).toContain('Tunnel connected.')
  })

  it('restarts a connector that crashes', async () => {
    const host = await startTunnelHost()
    await waitForState(host, 'connected')
    const first = host.records()[0]!.pid
    await host.fakeOrder('exit')
    await waitForState(host, 'down', undefined, (status) => status.reason === 'exited')
    const status = await waitForState(host, 'connected', undefined, (s) => s.restarts === 1)
    expect(status.route).toBe(`https://${HOSTNAME}`)
    expect(host.records()).toHaveLength(2)
    expect(host.records()[1]!.pid).not.toBe(first)
  })

  it('shows a connector that lost its connections as down, and restarts one that stays down', async () => {
    const host = await startTunnelHost({ timing: { unreadyRestartMs: 600 } })
    await waitForState(host, 'connected')
    await host.fakeOrder('unready')
    await waitForState(host, 'down', undefined, (status) => status.reason === 'reconnecting')
    expect(stateOf(host).route).toBeUndefined()
    // cloudflared reconnects by itself first: no restart yet.
    await host.fakeOrder('ready')
    await waitForState(host, 'connected')
    expect(host.records()).toHaveLength(1)
    // A connector that stays disconnected is replaced.
    await host.fakeOrder('unready')
    await waitForState(host, 'connected', undefined, (status) => status.restarts === 1)
    expect(host.records()).toHaveLength(2)
  })

  it('does not offer a hostname that answers as another environment', async () => {
    let answer: { status: number; body: unknown } = {
      status: 200,
      body: { environmentId: 'someone-else' },
    }
    const host = await startTunnelHost({ target: () => answer })
    const status = await waitForState(host, 'self_check_failed')
    expect(status.reason).toBe('other_environment')
    expect(status.route).toBeUndefined()
    answer = { status: 502, body: {} }
    await waitForState(host, 'self_check_failed', undefined, (s) => s.reason === 'http_502')
    answer = { status: 200, body: { environmentId: host.server.identity.environmentId } }
    await waitForState(host, 'connected')
    // A wrong hostname is the dashboard's doing; the connector is left alone.
    expect(host.records()).toHaveLength(1)
  })

  it('reports a missing binary and keeps serving locally', async () => {
    const host = await startTunnelHost({ binary: join(tmpdir(), 'no-such-dir', 'cloudflared') })
    await waitForState(host, 'binary_missing')
    expect(host.spawned).toEqual([])
    expect(
      await hostRequest(host.server.port, '/health', { host: `127.0.0.1:${host.server.port}` }),
    ).toBe(200)
  })

  it('reports a missing token, and picks up a token file saved later', async () => {
    const host = await startTunnelHost({ token: null, timing: { restartMaxMs: 100 } })
    await waitForState(host, 'token_missing')
    expect(host.spawned).toEqual([])
    writeFileSync(join(host.dataDir, 'tunnel-token'), 'two\nlines\n')
    await waitForState(host, 'token_missing', undefined, (s) => s.reason === 'token_malformed')
    writeFileSync(join(host.dataDir, 'tunnel-token'), `${TOKEN}\n`)
    await waitForState(host, 'connected')
    expect(host.records()[0]!.token).toBe(TOKEN)
  })

  it('names a token Cloudflare refuses', async () => {
    const invalid = await startTunnelHost({ mode: 'invalid_token' })
    await waitForState(invalid, 'down', undefined, (status) => status.reason === 'token_invalid')
    const rejected = await startTunnelHost({ mode: 'rejected' })
    await waitForState(
      rejected,
      'starting',
      undefined,
      (status) => status.reason === 'tunnel_rejected',
    )
  })

  it('warns when the tunnel also routes other services', async () => {
    const host = await startTunnelHost({
      ingress: {
        config: {
          ingress: [
            { hostname: HOSTNAME, service: 'http://127.0.0.1:1' },
            { hostname: 'files.test', service: 'http://127.0.0.1:3000' },
            { service: 'http_status:404' },
          ],
        },
      },
    })
    await waitForState(host, 'connected', undefined, (status) => status.sharedIngress === true)
    await host.close()
    expect(readFileSync(host.logFile, 'utf8')).toContain('also routes other hostnames')
  })

  it('notices a dashboard change that adds another service', async () => {
    const host = await startTunnelHost()
    await waitForState(host, 'connected', undefined, (status) => status.sharedIngress === false)
    await host.fakeOrder('reconfigure')
    await waitForState(host, 'connected', undefined, (status) => status.sharedIngress === true)
  })

  it('replaces a connector that never connects', async () => {
    const host = await startTunnelHost({ mode: 'never_ready', timing: { startTimeoutMs: 300 } })
    await waitFor(() => host.records().length >= 2, 'a second connector')
    expect(stateOf(host).restarts).toBeGreaterThanOrEqual(1)
    expect(stateOf(host).state).toMatch(/^(starting|down)$/)
  })

  it('stops cleanly while a restart is waiting out its backoff', async () => {
    const host = await startTunnelHost({ timing: { restartMinMs: 5_000, restartMaxMs: 5_000 } })
    await waitForState(host, 'connected')
    await host.fakeOrder('exit')
    await waitForState(host, 'down', undefined, (status) => status.reason === 'exited')
    await host.close()
    expect(stateOf(host).state).toBe('stopped')
    await new Promise((resolveWait) => setTimeout(resolveWait, 200))
    expect(host.records()).toHaveLength(1)
  })

  it('checks the replacement even when the old connector had a check in flight', async () => {
    let hold: Promise<void> | undefined
    let release = () => {}
    let serverPort = 0
    const host = await startTunnelHost({
      target: async () => {
        if (hold) await hold
        return { port: serverPort }
      },
    })
    serverPort = host.server.port
    await waitForState(host, 'connected')
    // The next check hangs; the connector is replaced while it does.
    hold = new Promise<void>((resolveHold) => {
      release = resolveHold
    })
    await host.fakeOrder('unready')
    await waitForState(host, 'down')
    await host.fakeOrder('ready')
    await waitForState(host, 'checking')
    await host.fakeOrder('exit')
    await waitFor(() => host.records().length === 2, 'a replacement connector')
    await waitForState(host, 'checking', undefined, (status) => status.restarts === 1)
    hold = undefined
    release()
    await waitForState(host, 'connected', undefined, (status) => status.restarts === 1)
  })

  it('rechecks after a sleep and restarts a connector whose connections went stale', async () => {
    let offset = 0
    let answer: { status: number; body: unknown } | undefined
    let serverPort = 0
    const host = await startTunnelHost({
      now: () => Date.now() + offset,
      target: () => answer ?? { port: serverPort },
    })
    serverPort = host.server.port
    await waitForState(host, 'connected')
    // Woke up: the connector still claims its connections, but Cloudflare
    // says the tunnel has none.
    answer = { status: 530, body: {} }
    offset += 120_000
    await waitFor(() => host.records().length === 2, 'a fresh connector after the sleep')
    answer = undefined
    const status = await waitForState(host, 'connected', undefined, (s) => s.restarts === 1)
    expect(status.route).toBe(`https://${HOSTNAME}`)
    await host.close()
    expect(readFileSync(host.logFile, 'utf8')).toContain('the machine probably slept')
  })
})

describe('tunnel off', () => {
  it('runs no connector and forgets an old status file', async () => {
    const dataDir = await tempDir('openmanager-tunnel-off-')
    writeFileSync(join(dataDir, TUNNEL_STATUS_FILE_NAME), '{"state":"connected"}')
    const server = await startServer({ port: 0, dataDir, logLevel: 'silent' })
    cleanups.push(() => server.close())
    expect(server.tunnel).toBeUndefined()
    expect(existsSync(join(dataDir, TUNNEL_STATUS_FILE_NAME))).toBe(false)
  })
})
