import { ChildProcess, spawn } from 'child_process'
import { BrowserWindow } from 'electron'
import type { SidecarHandshake, SidecarStatus } from '@shared/contracts/sidecar'
import { ACPConnection } from './acp-connection'

interface SidecarInstance {
  process: ChildProcess
  handshake: SidecarHandshake
  status: SidecarStatus
  restartCount: number
  acpConnection?: ACPConnection
}

const MAX_RESTARTS = 1

export class SidecarManager {
  private instance: SidecarInstance | null = null
  private startPromise: Promise<SidecarHandshake> | null = null

  async spawn(): Promise<SidecarHandshake> {
    if (this.instance?.status === 'healthy' && this.instance.handshake.ready) {
      return this.instance.handshake
    }
    if (this.startPromise) return this.startPromise

    this.startPromise = this.spawnInternal().finally(() => {
      this.startPromise = null
    })
    return await this.startPromise
  }

  async retryStart(): Promise<SidecarHandshake> {
    if (this.instance) {
      await this.shutdown().catch(() => undefined)
    }
    return await this.spawn()
  }

  private async spawnInternal(): Promise<SidecarHandshake> {
    const binary = process.env['OPENCODE_BINARY'] || 'opencode'
    const serverUrl = 'acp://stdio'

    const args = ['acp']
    console.log(`[sidecar] spawning: ${binary} ${args.join(' ')}`)
    console.log(`[sidecar] mode: acp`)
    console.log(`[sidecar] cwd: ${process.cwd()}`)

    const proc = spawn(binary, args, {
      cwd: process.cwd(),
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    proc.stdout?.on('data', (data: Buffer) => {
      console.log(`[sidecar:stdout] ${data.toString().trimEnd()}`)
    })

    proc.stderr?.on('data', (data: Buffer) => {
      console.error(`[sidecar:stderr] ${data.toString().trimEnd()}`)
    })

    proc.on('error', (err) => {
      console.error(`[sidecar] spawn error:`, err.message)
      instance.status = 'crashed'
      instance.handshake.ready = false
      this.broadcastStatus('crashed')
    })

    const handshake: SidecarHandshake = { serverUrl, password: '', ready: false }
    const instance: SidecarInstance = {
      process: proc,
      handshake,
      status: 'starting',
      restartCount: 0,
      acpConnection: new ACPConnection(proc),
    }

    this.instance = instance
    this.broadcastStatus('starting')

    proc.on('exit', (code, signal) => {
      console.log(`[sidecar] exited with code=${code} signal=${signal}`)
      if (instance.status === 'stopped') return
      instance.status = 'crashed'
      this.broadcastStatus('crashed')
      if (instance.restartCount < MAX_RESTARTS) {
        instance.restartCount++
        console.log(`[sidecar] restarting (attempt ${instance.restartCount})...`)
        this.spawn().catch(console.error)
      }
    })

    instance.handshake.ready = true
    instance.status = 'healthy'
    this.broadcastStatus('healthy')

    return instance.handshake
  }

  getHandshake(): SidecarHandshake | null {
    return this.instance?.handshake ?? null
  }

  getACPConnection(): ACPConnection | null {
    return this.instance?.acpConnection ?? null
  }

  getStatus(): SidecarStatus {
    return this.instance?.status ?? 'stopped'
  }

  async shutdown(): Promise<void> {
    const instance = this.instance
    if (!instance) return
    instance.status = 'stopped'
    instance.process.kill()
    this.instance = null
    this.broadcastStatus('stopped')
  }

  async shutdownAll(): Promise<void> {
    await this.shutdown()
  }

  private broadcastStatus(status: SidecarStatus): void {
    BrowserWindow.getAllWindows().forEach((win) => {
      win.webContents.send('opencode:status-changed', { status })
    })
  }
}
