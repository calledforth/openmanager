import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron'
import { join } from 'path'
import { ConvexClient } from 'convex/browser'
import { SidecarManager } from './sidecar-manager'
import { SSEBridge } from './sse-bridge'
import { JobWorker } from './job-worker'
import { OpenCodeClient } from '@shared/lib/opencode-client'
import { ACPClient } from './acp-client'
import { loadOrCreateClientId } from './client-id'
import { getLastSelectedModel, setLastSelectedModel } from './local-settings'
import type { AgentClient } from './agent-client'
import {
  clearConvexTelemetry,
  getConvexTelemetrySnapshot,
  initConvexTelemetry,
  recordConvexTelemetry,
} from './convex-telemetry'

declare const __CONVEX_URL__: string

const IDLE_CHECK_INTERVAL_MS = 60_000
const IDLE_THRESHOLD_MS = 10 * 60_000

let mainWindow: BrowserWindow | null = null
const sidecarManager = new SidecarManager()
const sseBridges = new Map<string, SSEBridge>()
const acpClients = new Map<string, ACPClient>()
let convexClient: ConvexClient | null = null
let jobWorker: JobWorker | null = null
let idleTimer: ReturnType<typeof setInterval> | null = null
let clientId: string | null = null
let userDataPath = ''

function initConvex(): ConvexClient | null {
  const url = __CONVEX_URL__
  if (!url) {
    console.warn('[convex] CONVEX_URL not set — Convex features disabled')
    return null
  }
  console.log('[convex] connecting to', url)
  return new ConvexClient(url)
}

async function ensureAgentClient(workspacePath: string): Promise<AgentClient | null> {
  sidecarManager.touchActivity(workspacePath)
  let hs = sidecarManager.getHandshake(workspacePath)
  if (!hs?.ready) {
    hs = await sidecarManager.spawn(workspacePath)
  }
  if (!hs?.ready) return null
  if (sidecarManager.getMode() === 'legacy') {
    startSSEBridge(workspacePath)
    return new OpenCodeClient(hs.serverUrl, hs.password)
  }

  if (!convexClient || !mainWindow) return null
  let bridge = sseBridges.get(workspacePath)
  if (!bridge && clientId) {
    bridge = new SSEBridge('', '', workspacePath, convexClient, mainWindow, clientId)
    sseBridges.set(workspacePath, bridge)
  }
  if (!bridge) return null

  let client = acpClients.get(workspacePath)
  if (!client) {
    const connection = sidecarManager.getACPConnection(workspacePath)
    if (!connection) return null
    client = new ACPClient(connection, workspacePath, bridge, mainWindow)
    acpClients.set(workspacePath, client)
  }
  await client.initialize()
  return client
}

function startSSEBridge(workspacePath: string): void {
  if (sseBridges.has(workspacePath) || !convexClient || !mainWindow || !clientId) return
  if (sidecarManager.getMode() !== 'legacy') return
  const hs = sidecarManager.getHandshake(workspacePath)
  if (!hs?.ready) return
  const bridge = new SSEBridge(hs.serverUrl, hs.password, workspacePath, convexClient, mainWindow, clientId)
  sseBridges.set(workspacePath, bridge)
  bridge.start()
}

function stopSSEBridge(workspacePath: string): void {
  sseBridges.get(workspacePath)?.stop()
  sseBridges.delete(workspacePath)
  acpClients.delete(workspacePath)
}

function shutdownIdleWorkspaces(): void {
  const idle = sidecarManager.getIdleWorkspaces(IDLE_THRESHOLD_MS)
  for (const path of idle) {
    console.log(`[idle-monitor] shutting down idle workspace: ${path}`)
    stopSSEBridge(path)
    sidecarManager.shutdown(path).catch(console.error)
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

ipcMain.handle('sidecar:spawn', async (_e, workspacePath: string) => {
  const handshake = await sidecarManager.spawn(workspacePath)
  if (handshake.ready) startSSEBridge(workspacePath)
  return handshake
})

ipcMain.handle('sidecar:handshake', async (_e, workspacePath: string) => {
  return sidecarManager.getHandshake(workspacePath)
})

ipcMain.handle('sidecar:status', async (_e, workspacePath: string) => {
  return sidecarManager.getStatus(workspacePath)
})

ipcMain.handle('sidecar:shutdown', async (_e, workspacePath: string) => {
  stopSSEBridge(workspacePath)
  return sidecarManager.shutdown(workspacePath)
})

ipcMain.handle('acp:load-session', async (_e, workspacePath: string, sessionId: string) => {
  const client = await ensureAgentClient(workspacePath)
  if (!client?.loadSession) return { ok: false, reason: 'load_session_not_supported' }
  await client.loadSession(sessionId)
  return { ok: true }
})

ipcMain.handle('dialog:select-folder', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
    title: 'Select Workspace Directory',
  })
  return result.filePaths[0] ?? null
})

ipcMain.handle('client:get-id', async () => clientId)
ipcMain.handle('telemetry:get-snapshot', async () => getConvexTelemetrySnapshot())
ipcMain.handle('telemetry:clear', async () => {
  clearConvexTelemetry()
})
ipcMain.handle('telemetry:record', async (_event, payload: Record<string, unknown>) => {
  recordConvexTelemetry({
    source: 'renderer',
    kind: (payload.kind as 'query' | 'mutation' | 'subscription' | 'trace') ?? 'trace',
    phase:
      (payload.phase as
        | 'start'
        | 'success'
        | 'error'
        | 'subscribe'
        | 'update'
        | 'unsubscribe'
        | 'mark') ?? 'mark',
    name: String(payload.name ?? 'renderer.unknown'),
    durationMs: typeof payload.durationMs === 'number' ? payload.durationMs : undefined,
    requestBytes: typeof payload.requestBytes === 'number' ? payload.requestBytes : undefined,
    responseBytes: typeof payload.responseBytes === 'number' ? payload.responseBytes : undefined,
    sessionExternalId:
      typeof payload.sessionExternalId === 'string' ? payload.sessionExternalId : undefined,
    workspacePath: typeof payload.workspacePath === 'string' ? payload.workspacePath : undefined,
    messageExternalId:
      typeof payload.messageExternalId === 'string' ? payload.messageExternalId : undefined,
    traceId: typeof payload.traceId === 'string' ? payload.traceId : undefined,
    details: typeof payload.details === 'string' ? payload.details : undefined,
  })
})

app.whenReady().then(() => {
  userDataPath = app.getPath('userData')
  clientId = loadOrCreateClientId(userDataPath)
  initConvexTelemetry(userDataPath)
  convexClient = initConvex()

  createWindow()

  if (convexClient && clientId) {
    console.log('[job-worker] starting')
    jobWorker = new JobWorker(
      convexClient,
      ensureAgentClient,
      clientId,
      (workspacePath) => getLastSelectedModel(userDataPath, workspacePath),
      (workspacePath, modelId) => setLastSelectedModel(userDataPath, workspacePath, modelId),
    )
    jobWorker.start()
  } else {
    console.warn('[job-worker] skipped — no Convex client')
  }

  idleTimer = setInterval(shutdownIdleWorkspaces, IDLE_CHECK_INTERVAL_MS)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', async () => {
  if (idleTimer) clearInterval(idleTimer)
  jobWorker?.stop()
  for (const bridge of sseBridges.values()) bridge.stop()
  await sidecarManager.shutdownAll()
})
