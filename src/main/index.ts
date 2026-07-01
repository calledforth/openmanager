import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron'
import { join } from 'path'
import { ConvexClient } from 'convex/browser'
import { SidecarManager } from './sidecar-manager'
import { SSEBridge } from './sse-bridge'
import { JobWorker } from './job-worker'
import { ACPClient } from './acp-client'
import { loadOrCreateClientId } from './client-id'
import store from './store'
import type { AgentClient } from './agent-client'
import {
  clearConvexTelemetry,
  getConvexTelemetrySnapshot,
  initConvexTelemetry,
  recordConvexTelemetry,
} from './convex-telemetry'

declare const __CONVEX_URL__: string

let mainWindow: BrowserWindow | null = null
const sidecarManager = new SidecarManager()
const sseBridges = new Map<string, SSEBridge>()
let acpClient: ACPClient | null = null
let convexClient: ConvexClient | null = null
let jobWorker: JobWorker | null = null
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
  let hs = sidecarManager.getHandshake()
  if (!hs?.ready) {
    hs = await sidecarManager.spawn()
  }
  if (!hs?.ready) return null

  if (!convexClient || !mainWindow) return null
  if (!acpClient) {
    const connection = sidecarManager.getACPConnection()
    if (!connection) return null
    acpClient = new ACPClient(connection, (path) => sseBridges.get(path) ?? null, mainWindow)
  }
  await acpClient.initialize()
  if (!sseBridges.has(workspacePath) && convexClient && mainWindow && clientId) {
    const bridge = new SSEBridge('', '', workspacePath, convexClient, mainWindow, clientId)
    sseBridges.set(workspacePath, bridge)
  }
  return acpClient.getWorkspaceClient(workspacePath)
}

function stopSSEBridge(workspacePath: string): void {
  sseBridges.get(workspacePath)?.stop()
  sseBridges.delete(workspacePath)
}

function createWindow(): void {
  const isMac = process.platform === 'darwin'
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    frame: isMac ? true : false,
    ...(isMac ? { titleBarStyle: 'hiddenInset' as const } : {}),
    backgroundColor: '#141414',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  mainWindow.on('maximize', () => mainWindow?.webContents.send('window:maximized-changed', true))
  mainWindow.on('unmaximize', () =>
    mainWindow?.webContents.send('window:maximized-changed', false),
  )

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

ipcMain.handle('opencode:ensure', async () => {
  const handshake = await sidecarManager.spawn()
  return handshake
})

ipcMain.handle('opencode:retry', async () => {
  const handshake = await sidecarManager.retryStart()
  return handshake
})

ipcMain.handle('opencode:status', async () => {
  return sidecarManager.getStatus()
})

ipcMain.handle('opencode:shutdown', async () => {
  for (const path of sseBridges.keys()) stopSSEBridge(path)
  return sidecarManager.shutdown()
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

ipcMain.handle('window:minimize', () => {
  mainWindow?.minimize()
})
ipcMain.handle('window:maximize', () => {
  if (!mainWindow) return
  if (mainWindow.isMaximized()) mainWindow.unmaximize()
  else mainWindow.maximize()
})
ipcMain.handle('window:close', () => {
  mainWindow?.close()
})
ipcMain.handle('window:is-maximized', () => mainWindow?.isMaximized() ?? false)

ipcMain.handle('client:get-id', async () => clientId)
ipcMain.handle('telemetry:get-snapshot', async () => getConvexTelemetrySnapshot())
ipcMain.handle('telemetry:clear', async () => {
  clearConvexTelemetry()
})

ipcMain.handle('store:get-collapsed-workspaces', async () => {
  return store.get('collapsedWorkspaces', [])
})

ipcMain.handle('store:set-collapsed-workspaces', async (_e, paths: string[]) => {
  store.set('collapsedWorkspaces', paths)
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

  sidecarManager.spawn().catch((error) => {
    console.error('[opencode] failed to start at app launch:', (error as Error).message)
  })

  if (convexClient && clientId) {
    console.log('[job-worker] starting')
    jobWorker = new JobWorker(
      convexClient,
      ensureAgentClient,
      clientId,
      (workspacePath) => {
        const models = store.get('lastSelectedModelByWorkspace', {})
        const model = models[workspacePath]
        return typeof model === 'string' && model.length > 0 ? model : null
      },
      (workspacePath, modelId) => {
        const models = store.get('lastSelectedModelByWorkspace', {})
        store.set('lastSelectedModelByWorkspace', { ...models, [workspacePath]: modelId })
      },
    )
    jobWorker.start()
  } else {
    console.warn('[job-worker] skipped — no Convex client')
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', async () => {
  jobWorker?.stop()
  for (const bridge of sseBridges.values()) bridge.stop()
  acpClient = null
  await sidecarManager.shutdownAll()
})
