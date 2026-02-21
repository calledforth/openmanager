import { ChildProcess, spawn } from 'child_process'
import { createServer } from 'net'
import { randomBytes } from 'crypto'
import { BrowserWindow } from 'electron'
import type { SidecarHandshake, SidecarStatus } from '@shared/contracts/sidecar'

interface SidecarInstance {
  process: ChildProcess
  handshake: SidecarHandshake
  status: SidecarStatus
  restartCount: number
  workspacePath: string
  lastActivityAt: number
}

const MAX_RESTARTS = 1
const HEALTH_TIMEOUT_MS = 30_000
const HEALTH_POLL_MS = 500

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      server.close(() => resolve(port))
    })
    server.on('error', reject)
  })
}

function basicAuthHeader(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
}

async function pollHealth(url: string, password: string): Promise<boolean> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS
  let attempt = 0
  while (Date.now() < deadline) {
    attempt++
    try {
      const res = await fetch(`${url}/global/health`, {
        headers: { Authorization: basicAuthHeader(password) },
        signal: AbortSignal.timeout(3000),
      })
      if (res.ok) return true
      const body = await res.text().catch(() => '')
      if (attempt <= 3 || attempt % 10 === 0) {
        console.log(`[sidecar:health] attempt ${attempt}: ${res.status} ${body.slice(0, 200)}`)
      }
    } catch (err) {
      if (attempt <= 3 || attempt % 10 === 0) {
        console.log(`[sidecar:health] attempt ${attempt}: ${(err as Error).message}`)
      }
    }
    await new Promise((r) => setTimeout(r, HEALTH_POLL_MS))
  }
  return false
}

export class SidecarManager {
  private instances = new Map<string, SidecarInstance>()

  async spawn(workspacePath: string): Promise<SidecarHandshake> {
    const existing = this.instances.get(workspacePath)
    if (existing?.status === 'healthy') {
      existing.lastActivityAt = Date.now()
      return existing.handshake
    }

    const password = randomBytes(32).toString('hex')
    const port = await findFreePort()
    const hostname = '127.0.0.1'
    const serverUrl = `http://${hostname}:${port}`

    const binary = process.env['OPENCODE_BINARY'] || 'opencode'
    console.log(`[sidecar] spawning: ${binary} serve --port ${port} --hostname ${hostname}`)
    console.log(`[sidecar] cwd: ${workspacePath}`)

    const proc = spawn(binary, ['serve', '--port', String(port), '--hostname', hostname], {
      cwd: workspacePath,
      env: { ...process.env, OPENCODE_SERVER_PASSWORD: password },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    proc.stdout?.on('data', (data: Buffer) => {
      console.log(`[sidecar:stdout] ${data.toString().trimEnd()}`)
    })

    proc.stderr?.on('data', (data: Buffer) => {
      console.error(`[sidecar:stderr] ${data.toString().trimEnd()}`)
    })

    proc.on('error', (err) => {
      console.error(`[sidecar] spawn error:`, err.message)
    })

    const handshake: SidecarHandshake = { serverUrl, password, ready: false }
    const instance: SidecarInstance = {
      process: proc,
      handshake,
      status: 'starting',
      restartCount: 0,
      workspacePath,
      lastActivityAt: Date.now(),
    }

    this.instances.set(workspacePath, instance)
    this.broadcastStatus(workspacePath, 'starting')

    proc.on('exit', (code, signal) => {
      console.log(`[sidecar] exited with code=${code} signal=${signal}`)
      if (instance.status === 'stopped') return
      instance.status = 'crashed'
      this.broadcastStatus(workspacePath, 'crashed')
      if (instance.restartCount < MAX_RESTARTS) {
        instance.restartCount++
        console.log(`[sidecar] restarting (attempt ${instance.restartCount})...`)
        this.spawn(workspacePath).catch(console.error)
      }
    })

    const healthy = await pollHealth(serverUrl, password)
    if (healthy) {
      console.log(`[sidecar] healthy on ${serverUrl}`)
      instance.handshake.ready = true
      instance.status = 'healthy'
      this.broadcastStatus(workspacePath, 'healthy')
    } else {
      console.error(`[sidecar] health check timed out after ${HEALTH_TIMEOUT_MS}ms`)
      instance.status = 'unhealthy'
      this.broadcastStatus(workspacePath, 'unhealthy')
    }

    return instance.handshake
  }

  touchActivity(workspacePath: string): void {
    const instance = this.instances.get(workspacePath)
    if (instance) instance.lastActivityAt = Date.now()
  }

  getIdleWorkspaces(thresholdMs: number): string[] {
    const now = Date.now()
    const idle: string[] = []
    for (const [path, instance] of this.instances) {
      if (instance.status === 'healthy' && now - instance.lastActivityAt > thresholdMs) {
        idle.push(path)
      }
    }
    return idle
  }

  getHandshake(workspacePath: string): SidecarHandshake | null {
    return this.instances.get(workspacePath)?.handshake ?? null
  }

  getStatus(workspacePath: string): SidecarStatus {
    return this.instances.get(workspacePath)?.status ?? 'stopped'
  }

  async shutdown(workspacePath: string): Promise<void> {
    const instance = this.instances.get(workspacePath)
    if (!instance) return
    instance.status = 'stopped'
    instance.process.kill()
    this.instances.delete(workspacePath)
    this.broadcastStatus(workspacePath, 'stopped')
  }

  async shutdownAll(): Promise<void> {
    const paths = [...this.instances.keys()]
    await Promise.all(paths.map((p) => this.shutdown(p)))
  }

  private broadcastStatus(workspacePath: string, status: SidecarStatus): void {
    BrowserWindow.getAllWindows().forEach((win) => {
      win.webContents.send('sidecar:status-changed', { workspacePath, status })
    })
  }
}
