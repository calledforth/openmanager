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
  type DurableEvent,
  type EventEnvelope,
} from '@openmanager/protocol/node'
import { providers, type HostDeps, type ProviderBootstrap as RuntimeProviderBootstrap } from '@agentpack/runtime/node'
import { mountAgentRuntime } from './agent-runtime.ts'
import { createComposerService, desiredSessionConfig } from './composer-service.ts'
import { openComposerStore } from './composer-store.ts'
import { auditValue, createAuditLog } from './audit.ts'
import type { ServerConfig } from './config.ts'
import { validateHosts, validateOrigins, validateWorkspaceRoots } from './config.ts'
import { openAuthorizedClients } from './authorized-clients.ts'
import { loadEnvironmentIdentity } from './identity.ts'
import {
  evaluateLocalOwnerAccess,
  LOCAL_OWNER_PATH,
} from './local-owner.ts'
import { createEventService } from './event-service.ts'
import { createLogger } from './logger.ts'
import { createProviderService } from './provider-service.ts'
import { createRateLimiter } from './rate-limit.ts'
import { createRequestGuard } from './request-guard.ts'
import { createThreadService, type WorkspaceRuntimeResolver } from './thread-service.ts'
import { attachWebSocket, SOCKET_CAPABILITIES } from './websocket.ts'
import { openWorkspaceRegistry } from './workspaces.ts'

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
  'workspace.list',
]

/** A loopback-only listener exposing public liveness and connection discovery. */
export async function startServer(config: ServerConfig) {
  const allowedOrigins = validateOrigins(config.allowedOrigins ?? [])
  const allowedHosts = validateHosts(config.allowedHosts ?? [])
  const workspaceRoots = validateWorkspaceRoots(config.workspaces ?? [])
  const log = createLogger(config.logLevel)
  const audit = createAuditLog(log)
  const rateLimiter = createRateLimiter()
  const identity = await loadEnvironmentIdentity(config.dataDir)
  const composerStore = openComposerStore(config.dataDir)
  const clients = openAuthorizedClients(config.dataDir)
  // Local first run needs no pairing UI: the process mints the owner credential.
  // Reminting is explicit (`--remint-owner` or `remintOwner()`), not a restart side effect.
  let owner = clients.ensureOwner()
  if (config.remintOwner) {
    const previousId = owner.clientId
    owner = clients.remintOwner().client
    audit.record({
      type: 'owner.reminted',
      clientId: owner.clientId,
      details: { previousClientId: previousId },
    })
  }
  let workspaces
  try {
    workspaces = openWorkspaceRegistry(config.dataDir, workspaceRoots, audit)
  } catch (error) {
    composerStore.close()
    clients.close()
    throw error
  }
  // Production routes every workspace through the registry: an ID resolves to
  // its canonical root or to nothing. The test seam may substitute a provider.
  const resolveWorkspace: WorkspaceRuntimeResolver =
    config.resolveWorkspace ??
    ((workspaceId, context) => {
      const workspace = workspaces.resolve(workspaceId, context)
      return workspace ? { providerId: 'opencode', cwd: workspace.root } : undefined
    })
  let onRuntimeEvent: HostDeps['emitEvent'] = () => undefined
  const runtime = mountAgentRuntime(
    log,
    (event) => onRuntimeEvent(event),
    ({ providerId, workspacePath }) =>
      desiredSessionConfig(composerStore.getPreference(workspacePath, providerId)),
    config.runtimeOptions,
  )
  let observeProviderCatalog: (providerId: string, result: RuntimeProviderBootstrap) => void =
    () => undefined
  const providerService = createProviderService(
    runtime,
    providers,
    (providerId, result) => observeProviderCatalog(providerId, result),
    resolveWorkspace,
  )
  let publishDurableEvent: (record: DurableEvent) => void = () => undefined
  let publishThreadEvent: (event: EventEnvelope) => void = () => undefined
  const eventService = createEventService((record) => publishDurableEvent(record))
  const threadService = createThreadService(
    runtime,
    providerService,
    (event) => eventService.append(event),
    (event) => publishThreadEvent(event),
    resolveWorkspace,
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
  const guard = createRequestGuard({
    allowedOrigins,
    allowedHosts,
    port: () => (server.address() as AddressInfo | null)?.port ?? config.port,
    audit,
  })
  const server = createServer((request, response) => {
    response.setHeader('Vary', 'Origin')
    const rejection = guard.check(request)
    if (rejection) {
      response.writeHead(rejection.status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      response.end(
        JSON.stringify({
          type: 'error',
          requestId: null,
          error: { code: rejection.code, message: rejection.message },
        }),
      )
      return
    }
    if (request.headers.origin !== undefined) {
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
    if (request.method === 'GET' && path === LOCAL_OWNER_PATH) {
      const remoteAddress = request.socket.remoteAddress ?? 'unknown'
      const access = evaluateLocalOwnerAccess(
        request,
        (server.address() as AddressInfo | null)?.port ?? config.port,
      )
      if (access === 'not_found') {
        audit.record({
          type: 'owner.claim_denied',
          remoteAddress,
          details: { reason: 'not_local_route', host: auditValue(request.headers.host) },
        })
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        response.end('Not found\n')
        return
      }
      const lockout = rateLimiter.blocked('local_owner', remoteAddress)
      if (!lockout.allowed) {
        audit.record({
          type: 'rate_limited',
          remoteAddress,
          details: { policy: 'local_owner', retryAfterMs: lockout.retryAfterMs },
        })
        response.writeHead(429, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'retry-after': String(Math.ceil(lockout.retryAfterMs / 1000)),
        })
        response.end(
          JSON.stringify({
            type: 'error',
            requestId: null,
            error: { code: 'unavailable', message: 'Too many local owner requests.' },
          }),
        )
        return
      }
      rateLimiter.consume('local_owner', remoteAddress)
      if (access === 'forbidden') {
        audit.record({
          type: 'owner.claim_denied',
          remoteAddress,
          details: { reason: 'origin', origin: auditValue(request.headers.origin) },
        })
        response.writeHead(403, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        response.end(
          JSON.stringify({
            type: 'error',
            requestId: null,
            error: {
              code: 'auth',
              message: 'Local owner issuance requires a first-party loopback origin.',
            },
          }),
        )
        return
      }
      const credential = clients.publishedOwner()
      if (credential === undefined) {
        response.writeHead(503, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        response.end(
          JSON.stringify({
            type: 'error',
            requestId: null,
            error: { code: 'unavailable', message: 'Owner credential is not published.' },
          }),
        )
        return
      }
      audit.record({
        type: 'owner.claimed',
        clientId: owner.clientId,
        remoteAddress,
        details: { origin: auditValue(request.headers.origin) },
      })
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      response.end(
        JSON.stringify({
          environmentId: identity.environmentId,
          label: identity.label,
          kind: 'owner',
          grant: owner.capabilities,
          credential,
        }),
      )
      return
    }
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('Not found\n')
  })
  const sockets = attachWebSocket(server, {
    authenticate: (credential) => clients.authenticate(credential),
    guard,
    rateLimiter,
    audit,
    bootstrap,
    dispatchCommand: (command, context) =>
      workspaces.dispatch(command) ??
      threadService.dispatch(command, context) ??
      providerService.dispatch(command, context) ??
      composerService.dispatch(command),
  })
  publishDurableEvent = (record) => sockets.publish(record)
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
    clients.close()
    workspaces.close()
    throw error
  }
  const address = server.address() as AddressInfo
  websocketUrl = `ws://127.0.0.1:${address.port}/ws`
  providerService.start()
  let closePromise: Promise<void> | undefined
  return {
    identity,
    get owner() {
      return owner
    },
    clients,
    workspaces,
    audit,
    rateLimiter,
    runtime,
    threadService,
    composerService,
    composerStore,
    sockets,
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
    /** Revoke a client's credential and cut its live sockets in one step. */
    revokeClient(clientId: string): boolean {
      if (clientId === owner.clientId) return false
      const revoked = clients.revoke(clientId)
      if (revoked) sockets.disconnectClient(clientId)
      return revoked
    },
    /**
     * Replace the owner credential. The previous owner row is revoked and its
     * live sockets close; the new credential is published in the data directory.
     */
    remintOwner() {
      const previousId = owner.clientId
      const minted = clients.remintOwner()
      owner = minted.client
      sockets.disconnectClient(previousId)
      audit.record({
        type: 'owner.reminted',
        clientId: minted.client.clientId,
        details: { previousClientId: previousId },
      })
      return minted
    },
    close: () => {
      if (!closePromise) {
        const socketClose = sockets.close()
        const httpClose = new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()))
          server.closeAllConnections()
        })
        closePromise = Promise.all([socketClose, httpClose, runtime.shutdown()]).then(() => {
          composerStore.close()
          clients.close()
          workspaces.close()
        })
        stopHealthEvents()
        providerService.stop()
      }
      return closePromise
    },
  }
}
