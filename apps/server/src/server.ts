import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  BootstrapResponseSchema,
  COMPOSER_CONFIG_OPTION_SET_CAPABILITY,
  COMPOSER_MODEL_SET_CAPABILITY,
  COMPOSER_MODE_SET_CAPABILITY,
  COMPOSER_PREFERENCES_GET_CAPABILITY,
  COMPOSER_PREFERENCES_SET_CAPABILITY,
  PROTOCOL_VERSION,
  PROVIDER_CATALOG_CAPABILITY,
  PROVIDER_DISCOVERY_CAPABILITY,
  PROVIDER_HEALTH_CAPABILITY,
  PROVIDER_PROBE_CAPABILITY,
  type EventEnvelope,
} from '@openmanager/protocol/node'
import { providers, type HostDeps, type ProviderBootstrap as RuntimeProviderBootstrap } from '@agentpack/runtime/node'
import { mountAgentRuntime } from './agent-runtime.ts'
import { createComposerService } from './composer-service.ts'
import { openComposerStore } from './composer-store.ts'
import type { ServerConfig } from './config.ts'
import { validateOrigins } from './config.ts'
import { loadClientToken } from './credential.ts'
import { loadEnvironmentIdentity } from './identity.ts'
import { createLogger } from './logger.ts'
import { createProviderService } from './provider-service.ts'
import { createThreadService } from './thread-service.ts'
import { attachWebSocket, SOCKET_CAPABILITIES } from './websocket.ts'

export const SERVER_CAPABILITIES = [
  ...SOCKET_CAPABILITIES,
  PROVIDER_DISCOVERY_CAPABILITY,
  PROVIDER_HEALTH_CAPABILITY,
  PROVIDER_PROBE_CAPABILITY,
  PROVIDER_CATALOG_CAPABILITY,
  COMPOSER_PREFERENCES_GET_CAPABILITY,
  COMPOSER_PREFERENCES_SET_CAPABILITY,
  COMPOSER_MODEL_SET_CAPABILITY,
  COMPOSER_MODE_SET_CAPABILITY,
  COMPOSER_CONFIG_OPTION_SET_CAPABILITY,
  'session.create',
  'session.open',
  'turn.send',
  'turn.interrupt',
]

/** A loopback-only listener exposing public liveness and connection discovery. */
export async function startServer(config: ServerConfig) {
  const allowedOrigins = validateOrigins(config.allowedOrigins ?? [])
  const identity = await loadEnvironmentIdentity(config.dataDir)
  const token = await loadClientToken(config.dataDir)
  const composerStore = openComposerStore(config.dataDir)
  let onRuntimeEvent: HostDeps['emitEvent'] = () => undefined
  const runtime = mountAgentRuntime(
    createLogger(config.logLevel),
    (event) => onRuntimeEvent(event),
    ({ providerId, workspacePath }) => composerStore.getPreference(workspacePath, providerId),
  )
  let observeProviderCatalog: (providerId: string, result: RuntimeProviderBootstrap) => void =
    () => undefined
  const providerService = createProviderService(runtime, providers, (providerId, result) =>
    observeProviderCatalog(providerId, result),
  )
  let publishThreadEvent: (event: EventEnvelope) => void = () => undefined
  const threadService = createThreadService(runtime, providerService, (event) =>
    publishThreadEvent(event),
  )
  const composerService = createComposerService(
    runtime,
    providerService,
    composerStore,
    (sessionId) => threadService.resolveRuntimeSession(sessionId),
  )
  observeProviderCatalog = (providerId, result) => composerService.observeProbe(providerId, result)
  threadService.setEnvironmentId(identity.environmentId)
  onRuntimeEvent = (event) => {
    composerService.onRuntimeEvent(event)
    threadService.onRuntimeEvent(event)
  }
  // Set after listen so port 0 advertises the actual port selected by the OS.
  let websocketUrl: string
  const bootstrap = () =>
    BootstrapResponseSchema.parse({
      environmentId: identity.environmentId,
      label: identity.label,
      protocolVersion: PROTOCOL_VERSION,
      capabilities: SERVER_CAPABILITIES,
      providers: providerService.snapshot(),
      websocketUrl,
    })
  const server = createServer((request, response) => {
    response.setHeader('Vary', 'Origin')
    if (request.headers.origin !== undefined) {
      if (!allowedOrigins.includes(request.headers.origin)) {
        response.writeHead(403, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        response.end(
          JSON.stringify({
            type: 'error',
            requestId: null,
            error: { code: 'auth', message: 'Origin is not allowed.' },
          }),
        )
        return
      }
      response.setHeader('Access-Control-Allow-Origin', request.headers.origin)
    }
    const path = request.url?.split('?')[0]
    if (request.method === 'GET' && (path === '/health' || path === '/bootstrap')) {
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      response.end(JSON.stringify(path === '/health' ? { status: 'ok' } : bootstrap()))
      return
    }
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('Not found\n')
  })
  const sockets = attachWebSocket(server, {
    token,
    allowedOrigins,
    bootstrap,
    dispatchCommand: (command) =>
      threadService.dispatch(command) ??
      providerService.dispatch(command) ??
      composerService.dispatch(command),
  })
  publishThreadEvent = (event) => sockets.publishEvent(event)
  const stopHealthEvents = providerService.onHealthChanged((event) => sockets.publishEvent(event))
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(config.port, '127.0.0.1', () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
  } catch (error) {
    await sockets.close()
    stopHealthEvents()
    providerService.stop()
    await runtime.shutdown()
    composerStore.close()
    throw error
  }
  const address = server.address() as AddressInfo
  websocketUrl = `ws://127.0.0.1:${address.port}/ws`
  providerService.start()
  let closePromise: Promise<void> | undefined
  return {
    identity,
    runtime,
    threadService,
    composerService,
    composerStore,
    sockets,
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
    close: () => {
      if (!closePromise) {
        const socketClose = sockets.close()
        const httpClose = new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()))
          server.closeAllConnections()
        })
        closePromise = Promise.all([socketClose, httpClose, runtime.shutdown()]).then(() => {
          composerStore.close()
        })
        stopHealthEvents()
        providerService.stop()
      }
      return closePromise
    },
  }
}
