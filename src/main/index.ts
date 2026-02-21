import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron'
import { join } from 'path'
import { ConvexClient } from 'convex/browser'
import { SidecarManager } from './sidecar-manager'
import { SSEBridge } from './sse-bridge'
import { JobWorker } from './job-worker'
import { OpenCodeClient } from '@shared/lib/opencode-client'

declare const __CONVEX_URL__: string

const IDLE_CHECK_INTERVAL_MS = 60_000
const IDLE_THRESHOLD_MS = 10 * 60_000

let mainWindow: BrowserWindow | null = null
const sidecarManager = new SidecarManager()
const sseBridges = new Map<string, SSEBridge>()
let convexClient: ConvexClient | null = null
let jobWorker: JobWorker | null = null
let idleTimer: ReturnType<typeof setInterval> | null = null

function initConvex(): ConvexClient | null {
  const url = __CONVEX_URL__
  if (!url) {
    console.warn('[convex] CONVEX_URL not set — Convex features disabled')
    return null
  }
  console.log('[convex] connecting to', url)
  return new ConvexClient(url)
}

function getOpenCodeClient(workspacePath: string): OpenCodeClient | null {
  sidecarManager.touchActivity(workspacePath)
  const hs = sidecarManager.getHandshake(workspacePath)
  if (!hs?.ready) return null
  return new OpenCodeClient(hs.serverUrl, hs.password)
}

function startSSEBridge(workspacePath: string): void {
  if (sseBridges.has(workspacePath) || !convexClient) return
  const hs = sidecarManager.getHandshake(workspacePath)
  if (!hs?.ready) return
  const bridge = new SSEBridge(hs.serverUrl, hs.password, workspacePath, convexClient)
  sseBridges.set(workspacePath, bridge)
  bridge.start()
}

function stopSSEBridge(workspacePath: string): void {
  sseBridges.get(workspacePath)?.stop()
  sseBridges.delete(workspacePath)
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

ipcMain.handle('dialog:select-folder', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
    title: 'Select Workspace Directory',
  })
  return result.filePaths[0] ?? null
})

app.whenReady().then(() => {
  convexClient = initConvex()

  if (convexClient) {
    console.log('[job-worker] starting')
    jobWorker = new JobWorker(convexClient, getOpenCodeClient)
    jobWorker.start()
  } else {
    console.warn('[job-worker] skipped — no Convex client')
  }

  idleTimer = setInterval(shutdownIdleWorkspaces, IDLE_CHECK_INTERVAL_MS)

  createWindow()

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
