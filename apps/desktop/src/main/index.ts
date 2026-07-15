import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron'
import { join } from 'path'
import { ConvexClient } from 'convex/browser'
import { api } from '@openmanager/convex/_generated/api'
import { JobWorker } from './job-worker'
import { AgentHost } from './agent-host'
import { ConvexProjector } from './convex-projector'
import { isProviderId, type ProviderId, type ProviderMetadata } from '@agentpack/contract'
import { providers } from '@agentpack/runtime'
import { loadOrCreateClientId } from './client-id'
import store from './store'
import { normalizeConvexUrl, resolveRuntimeConfig } from './convex-config'
import type { ConvexConnectionResult, RuntimeConfig } from '../shared/runtime-config'
import { startUpdateService } from './update-service'
import {
  clearConvexTelemetry,
  getConvexTelemetrySnapshot,
  initConvexTelemetry,
  recordConvexTelemetry,
} from './convex-telemetry'

declare const __CONVEX_URL__: string

let mainWindow: BrowserWindow | null = null
let agentHost: AgentHost | null = null
let convexClient: ConvexClient | null = null
let jobWorker: JobWorker | null = null
let clientId: string | null = null
let userDataPath = ''

function getRuntimeConfig(): RuntimeConfig {
  return resolveRuntimeConfig(store.get('convexUrl', ''), __CONVEX_URL__, !app.isPackaged)
}

function initConvex(): ConvexClient | null {
  const config = getRuntimeConfig()
  if (!config.convexUrl) {
    console.warn('[convex] CONVEX_URL not set — Convex features disabled')
    return null
  }
  console.log(`[convex] connecting via ${config.convexSource} configuration`)
  return new ConvexClient(config.convexUrl)
}

async function testConvexDeployment(rawUrl: string): Promise<ConvexConnectionResult> {
  let normalizedUrl: string
  try {
    normalizedUrl = normalizeConvexUrl(rawUrl, !app.isPackaged)
  } catch (error) {
    return { ok: false, error: (error as Error).message }
  }

  const testClient = new ConvexClient(normalizedUrl)
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      testClient.query(api.workspaces.list, {}),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Connection timed out after 10 seconds.')),
          10_000,
        )
      }),
    ])
    return { ok: true, normalizedUrl }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The deployment could not be reached.'
    return { ok: false, error: message }
  } finally {
    if (timeout) clearTimeout(timeout)
    await testClient.close().catch((error) => {
      console.warn('[convex] test client did not close cleanly:', error)
    })
  }
}

function getAgentHost(): AgentHost {
  if (!agentHost) throw new Error('Agent runtime is unavailable')
  return agentHost
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
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('window:maximized-changed', false))

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

ipcMain.handle('agent:ensure', async (_e, providerId: unknown, cwd: string) => {
  if (!isProviderId(providerId)) throw new Error(`Unknown provider: ${String(providerId)}`)
  return getAgentHost().ensureProvider(providerId, cwd || process.cwd())
})

ipcMain.handle('agent:status', async () => {
  return agentHost?.getStatuses() ?? {}
})

ipcMain.handle('agent:providers', (): ProviderMetadata[] =>
  Object.values(providers).map(({ id, displayName, capabilities }) => ({
    id,
    displayName,
    capabilities,
  })),
)

ipcMain.handle(
  'acp:load-session',
  async (_e, providerId: unknown, workspacePath: string, sessionId: string) => {
    if (!isProviderId(providerId)) throw new Error(`Unknown provider: ${String(providerId)}`)
    const host = getAgentHost()
    if (!host.runtime.getProvider(providerId).capabilities.canLoadSession) {
      return { ok: false, reason: 'load_session_not_supported' }
    }
    await host.runtime.ensureSession({
      providerId,
      threadId: sessionId,
      workspaceId: workspacePath,
      cwd: workspacePath,
      sessionId,
    })
    return { ok: true }
  },
)

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
ipcMain.handle('config:get-runtime', async () => getRuntimeConfig())
ipcMain.handle('config:test-convex-url', async (_event, url: string) => {
  return testConvexDeployment(url)
})
ipcMain.handle('config:set-convex-url', async (_event, url: string) => {
  const result = await testConvexDeployment(url)
  if (!result.ok || !result.normalizedUrl) return result

  store.set('convexUrl', result.normalizedUrl)
  const restartTimer = setTimeout(() => {
    app.relaunch()
    app.exit(0)
  }, 300)
  restartTimer.unref()
  return result
})
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

ipcMain.handle('store:get-last-provider', async (): Promise<ProviderId> => {
  const value = store.get('lastUsedProviderId', 'opencode')
  return isProviderId(value) ? value : 'opencode'
})

ipcMain.handle('store:set-last-provider', async (_e, providerId: unknown) => {
  if (!isProviderId(providerId)) throw new Error(`Unknown provider: ${String(providerId)}`)
  store.set('lastUsedProviderId', providerId)
})
ipcMain.handle('telemetry:record', async (_event, payload: Record<string, unknown>) => {
  recordConvexTelemetry({
    source: 'renderer',
    kind: (payload.kind as 'query' | 'mutation' | 'subscription' | 'trace') ?? 'trace',
    phase:
      (payload.phase as
        'start' | 'success' | 'error' | 'subscribe' | 'update' | 'unsubscribe' | 'mark') ?? 'mark',
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
  startUpdateService()

  if (convexClient && clientId) {
    const projector = new ConvexProjector(convexClient, clientId)
    agentHost = new AgentHost(projector, () => mainWindow)
    const lastUsed = store.get('lastUsedProviderId', 'opencode')
    const startupProviderId: ProviderId = isProviderId(lastUsed) ? lastUsed : 'opencode'
    agentHost.ensureProvider(startupProviderId, process.cwd()).catch((error) => {
      console.error(
        `[agent] failed to start ${startupProviderId} at app launch:`,
        (error as Error).message,
      )
    })
    console.log('[job-worker] starting')
    jobWorker = new JobWorker(
      convexClient,
      agentHost,
      clientId,
      (workspacePath, providerId) => {
        const models = store.get('lastSelectedModelByWorkspace', {})
        // Legacy entries were keyed by workspace alone, before Cursor support.
        const model =
          models[`${workspacePath}::${providerId}`] ??
          (providerId === 'opencode' ? models[workspacePath] : undefined)
        return typeof model === 'string' && model.length > 0 ? model : null
      },
      (workspacePath, providerId, modelId) => {
        const models = store.get('lastSelectedModelByWorkspace', {})
        store.set('lastSelectedModelByWorkspace', {
          ...models,
          [`${workspacePath}::${providerId}`]: modelId,
        })
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
  agentHost?.dispose()
  agentHost = null
})
