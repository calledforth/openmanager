import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron'
import { join } from 'path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ConvexClient } from 'convex/browser'
import { api } from '@openmanager/convex/_generated/api'
import { JobWorker } from './job-worker'
import { AgentHost } from './agent-host'
import { ConvexProjector } from './convex-projector'
import {
  isProviderId,
  PROVIDER_IDS,
  type ProviderId,
  type ProviderMetadata,
} from '@agentpack/contract'
import { opencode as opencodeProvider, providers } from '@agentpack/runtime'
import { loadOrCreateClientId } from './client-id'
import { sanitizeProviderHealthCache } from './provider-health-cache'
import store from './store'
import { normalizeConvexUrl, resolveRuntimeConfig } from './convex-config'
import type { ConvexConnectionResult, RuntimeConfig } from '../shared/runtime-config'
import {
  workspaceComposerPreferenceKey,
  type ProviderComposerProfile,
  type WorkspaceComposerPreference,
  type WorkspaceComposerPreferences,
} from '../shared/composer-profile'
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
const execFileAsync = promisify(execFile)
const modelImageSupportCache = new Map<string, boolean | null>()

/** The workspace's remembered model for a provider, preferring the composer
 * preference and falling back to the pre-Cursor `lastSelectedModelByWorkspace`
 * shape. */
function lastModelForWorkspace(workspacePath: string, providerId: ProviderId): string | null {
  const preference = store.get('workspaceComposerPreferences', {})[
    workspaceComposerPreferenceKey(workspacePath, providerId)
  ]
  if (preference?.modelId) return preference.modelId
  const models = store.get('lastSelectedModelByWorkspace', {})
  // Legacy entries were keyed by workspace alone, before Cursor support.
  const model =
    models[`${workspacePath}::${providerId}`] ??
    (providerId === 'opencode' ? models[workspacePath] : undefined)
  return typeof model === 'string' && model.length > 0 ? model : null
}

function configValuesForWorkspace(
  workspacePath: string,
  providerId: ProviderId,
): Record<string, string | boolean> | undefined {
  return store.get('workspaceComposerPreferences', {})[
    workspaceComposerPreferenceKey(workspacePath, providerId)
  ]?.configValues
}

/** The durable desired config for a workspace + provider, from the one place
 * it is persisted.
 *
 * Both the job worker (which layers per-job overrides on top) and the agent
 * runtime (which asks for it whenever it opens a session with no explicit
 * config) read the workspace's intent through these two functions, so there is
 * no second copy to go stale. Mode is deliberately left out: it is persisted
 * for the composer's benefit, but applying a remembered mode to every session
 * a respawn touches would fight the plan/execute flow, which sets mode per
 * turn. */
function desiredConfigForWorkspace(
  workspacePath: string,
  providerId: ProviderId,
): { modelId?: string; values?: Record<string, string | boolean> } | undefined {
  const modelId = lastModelForWorkspace(workspacePath, providerId) ?? undefined
  const values = configValuesForWorkspace(workspacePath, providerId)
  const desired = {
    ...(modelId ? { modelId } : {}),
    ...(values ? { values } : {}),
  }
  return Object.keys(desired).length > 0 ? desired : undefined
}

function jsonObjects(output: string): Array<Record<string, any>> {
  const objects: Array<Record<string, any>> = []
  let start = -1
  let depth = 0
  let quoted = false
  let escaped = false
  for (let index = 0; index < output.length; index += 1) {
    const char = output[index]
    if (quoted) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quoted = false
      continue
    }
    if (char === '"') quoted = true
    else if (char === '{') {
      if (depth === 0) start = index
      depth += 1
    } else if (char === '}' && depth > 0) {
      depth -= 1
      if (depth === 0 && start >= 0) {
        try {
          objects.push(JSON.parse(output.slice(start, index + 1)))
        } catch {
          // Ignore a malformed model block and leave support unknown.
        }
        start = -1
      }
    }
  }
  return objects
}

async function modelSupportsImages(
  providerId: ProviderId,
  modelId: string,
): Promise<boolean | null> {
  if (providerId !== 'opencode' || !modelId.includes('/')) return null
  if (modelImageSupportCache.has(modelId)) return modelImageSupportCache.get(modelId) ?? null
  const [modelProvider] = modelId.split('/', 1)
  // Named directly rather than read out of `providers`, whose values are the
  // whole provider union: `command` lives on the ACP arm, and this call is
  // about OpenCode's own CLI, so there is nothing to narrow.
  const command = process.env.ACP_OPENCODE_BIN ?? opencodeProvider.command.bin
  try {
    const { stdout } = await execFileAsync(
      command,
      ['models', modelProvider, '--verbose', '--pure'],
      { windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
    )
    const model = jsonObjects(stdout).find(
      (item) => `${String(item.providerID)}/${String(item.id)}` === modelId,
    )
    const value =
      typeof model?.capabilities?.input?.image === 'boolean'
        ? (model.capabilities.input.image as boolean)
        : null
    modelImageSupportCache.set(modelId, value)
    return value
  } catch {
    modelImageSupportCache.set(modelId, null)
    return null
  }
}

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
  return agentHost?.getHealth() ?? {}
})

ipcMain.handle('agent:prompt-capabilities', async () => {
  return agentHost?.getPromptCapabilities() ?? {}
})

// Static config plus whatever the probes have learned. `models` is the part
// that changes after launch: a provider that can answer its catalog at
// handshake time has none here until its first probe lands, so the renderer
// re-reads this whenever provider health changes rather than once on mount.
ipcMain.handle('agent:providers', (): ProviderMetadata[] => {
  const models = agentHost?.getProviderModels() ?? {}
  return Object.values(providers).map(({ id, displayName, capabilities }) => ({
    id,
    displayName,
    capabilities,
    ...(models[id] ? { models: models[id] } : {}),
  }))
})

ipcMain.handle(
  'agent:model-image-support',
  async (_event, providerId: unknown, modelId: string) => {
    if (!isProviderId(providerId)) return null
    return modelSupportsImages(providerId, modelId)
  },
)

ipcMain.handle(
  'acp:load-session',
  async (_e, providerId: unknown, workspacePath: string, sessionId: string) => {
    if (!isProviderId(providerId)) throw new Error(`Unknown provider: ${String(providerId)}`)
    const host = getAgentHost()
    if (!host.runtime.getProvider(providerId).capabilities.canLoadSession) {
      return { ok: false, reason: 'load_session_not_supported' }
    }
    // No `desiredConfig` here on purpose: the runtime asks
    // `desiredSessionConfig` for the workspace's current selection, which is
    // the same answer this handler could compute and cannot be a stale copy of
    // it. Opening a session from the sidebar therefore configures its process
    // exactly as sending a message would.
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

ipcMain.handle('store:get-last-active-workspace', async (): Promise<string> => {
  return store.get('lastActiveWorkspacePath', '')
})

ipcMain.handle('store:set-last-active-workspace', async (_e, workspacePath: unknown) => {
  if (typeof workspacePath !== 'string') throw new Error('Workspace path must be a string')
  store.set('lastActiveWorkspacePath', workspacePath)
})

ipcMain.handle('store:get-provider-composer-profiles', async () => {
  return store.get('providerComposerProfiles', {})
})

ipcMain.handle(
  'store:set-provider-composer-profile',
  async (_e, providerId: unknown, profile: unknown) => {
    if (!isProviderId(providerId)) throw new Error(`Unknown provider: ${String(providerId)}`)
    if (!profile || typeof profile !== 'object')
      throw new Error('Invalid provider composer profile')
    const profiles = store.get('providerComposerProfiles', {})
    store.set('providerComposerProfiles', {
      ...profiles,
      [providerId]: {
        ...(profiles[providerId] ?? {}),
        ...(profile as ProviderComposerProfile),
      },
    })
  },
)

ipcMain.handle('store:get-workspace-composer-preferences', async () => {
  const preferences = {
    ...store.get('workspaceComposerPreferences', {}),
  } as WorkspaceComposerPreferences
  const legacyModels = store.get('lastSelectedModelByWorkspace', {})
  for (const [legacyKey, modelId] of Object.entries(legacyModels)) {
    if (!modelId) continue
    // Every known provider, not a frozen pair: a key already suffixed with a
    // provider this list is missing reads as unsuffixed and gets a second
    // suffix appended (`…::claude` -> `…::claude::opencode`), which is a
    // preference the renderer can never look up again.
    const providerSuffix = PROVIDER_IDS.find((providerId) => legacyKey.endsWith(`::${providerId}`))
    const key = providerSuffix ? legacyKey : workspaceComposerPreferenceKey(legacyKey, 'opencode')
    preferences[key] = {
      ...(preferences[key] ?? {}),
      modelId: preferences[key]?.modelId ?? modelId,
    }
  }
  return preferences
})

ipcMain.handle(
  'store:set-workspace-composer-preference',
  async (_e, workspacePath: unknown, providerId: unknown, preference: unknown) => {
    if (typeof workspacePath !== 'string') throw new Error('Workspace path must be a string')
    if (!isProviderId(providerId)) throw new Error(`Unknown provider: ${String(providerId)}`)
    if (!preference || typeof preference !== 'object')
      throw new Error('Invalid workspace composer preference')
    const key = workspaceComposerPreferenceKey(workspacePath, providerId)
    const preferences = store.get('workspaceComposerPreferences', {})
    store.set('workspaceComposerPreferences', {
      ...preferences,
      [key]: {
        ...(preferences[key] ?? {}),
        ...(preference as WorkspaceComposerPreference),
      },
    })
  },
)

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
    const lastUsed = store.get('lastUsedProviderId', 'opencode')
    const startupProviderId: ProviderId = isProviderId(lastUsed) ? lastUsed : 'opencode'
    // Probe in the workspace the user was last in. Electron's own cwd is not a
    // workspace, and there is no longer a session-less shared process that
    // could usefully be started there; with no remembered workspace the
    // renderer's `agent:ensure` covers the first real one.
    const startupWorkspace = store.get('lastActiveWorkspacePath', '')
    agentHost = new AgentHost(projector, () => mainWindow, {
      healthCache: {
        load: () => sanitizeProviderHealthCache(store.get('providerHealth', {})),
        save: (cache) => store.set('providerHealth', cache),
      },
      // Every provider's health probe needs a real directory, not just the one
      // the user last used: at launch only one provider is started, and the
      // other must still be checkable.
      ...(startupWorkspace ? { probeCwd: startupWorkspace } : {}),
      // The one place the durable composer selection lives. The runtime asks
      // this whenever it opens a session it was given no explicit config for —
      // a respawn after a reap, a `set_model` on a dead thread, a session
      // opened from the sidebar — so a fresh Cursor process is corrected off
      // the model it restored from disk rather than inheriting it.
      desiredSessionConfig: ({ providerId, workspacePath }) =>
        desiredConfigForWorkspace(workspacePath, providerId),
    })
    // Order matters, and it is load-bearing. `ensureProvider` registers its
    // throwaway probe with the health monitor synchronously, before its first
    // await; starting the monitor afterwards lets its boot sweep adopt that
    // probe instead of spawning a second CLI for the same handshake. Starting
    // the monitor first (which constructing the host used to do) put two
    // `cursor-agent` processes on every launch.
    if (startupWorkspace) {
      agentHost.ensureProvider(startupProviderId, startupWorkspace).catch((error) => {
        console.error(
          `[agent] failed to probe ${startupProviderId} at app launch:`,
          (error as Error).message,
        )
      })
    }
    agentHost.startHealthMonitor()
    console.log('[job-worker] starting')
    jobWorker = new JobWorker(
      convexClient,
      agentHost,
      clientId,
      lastModelForWorkspace,
      configValuesForWorkspace,
      (workspacePath, providerId, modelId) => {
        const key = workspaceComposerPreferenceKey(workspacePath, providerId)
        const preferences = store.get('workspaceComposerPreferences', {})
        store.set('workspaceComposerPreferences', {
          ...preferences,
          [key]: {
            ...(preferences[key] ?? {}),
            modelId,
          },
        })
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

let quitting = false

// Electron does not await an async `before-quit` listener, so the previous
// shape sent SIGTERM to every CLI and then let the app exit immediately — the
// SIGKILL escalation never got to run and a child that ignored SIGTERM was
// orphaned. Hold the quit open explicitly instead, and re-emit it once every
// child is actually gone. `AgentRuntime.shutdown` is bounded, so this cannot
// wedge the quit.
app.on('before-quit', (event) => {
  if (quitting) return
  quitting = true
  event.preventDefault()
  const worker = jobWorker
  jobWorker = null
  const host = agentHost
  agentHost = null
  void (async () => {
    try {
      // Drain the worker *before* tearing runtimes down. A job that was
      // claimed a moment ago is about to call `ensureSession`, and a CLI
      // spawned after the shutdown sweep has taken its snapshot is an orphan.
      // The registry also refuses to start anything once shutdown begins, so
      // this is belt and braces — but the belt is what keeps the job from
      // failing with a confusing error instead of finishing.
      await worker?.stop()
    } catch (error) {
      console.error('[job-worker] stop failed:', (error as Error).message)
    }
    try {
      await host?.shutdown()
    } catch (error) {
      console.error('[agent] shutdown failed:', (error as Error).message)
    } finally {
      app.quit()
    }
  })()
})
