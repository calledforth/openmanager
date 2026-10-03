import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  PLAN_BUILD_CAPABILITY,
  BootstrapResponseSchema,
  COMPOSER_CONFIG_OPTION_SET_CAPABILITY,
  COMPOSER_EVENTS_CAPABILITY,
  COMPOSER_MODEL_SET_CAPABILITY,
  COMPOSER_MODE_SET_CAPABILITY,
  COMPOSER_PREFERENCES_GET_CAPABILITY,
  COMPOSER_PREFERENCES_SET_CAPABILITY,
  ENVIRONMENT_SETTINGS_GET_CAPABILITY,
  ENVIRONMENT_SETTINGS_SET_CAPABILITY,
  DRAFT_DELETE_CAPABILITY,
  DRAFT_LIST_CAPABILITY,
  DRAFT_SAVE_CAPABILITY,
  CLIENT_LIST_CAPABILITY,
  CLIENT_OWNER_ROTATE_CAPABILITY,
  CLIENT_RENAME_CAPABILITY,
  CLIENT_REVOKE_CAPABILITY,
  CLIENT_REVOKE_OTHERS_CAPABILITY,
  FILESYSTEM_BROWSE_CAPABILITY,
  PROTOCOL_VERSION,
  SESSION_CREATE_EXPLICIT_CAPABILITY,
  UPLOAD_TICKET_CAPABILITY,
  PROVIDER_CATALOG_CAPABILITY,
  PROVIDER_DISCOVERY_CAPABILITY,
  PROVIDER_HEALTH_CAPABILITY,
  PROVIDER_PROBE_CAPABILITY,
  PAIRING_CREATE_CAPABILITY,
  PAIRING_EXCHANGE_CAPABILITY,
  PAIRING_LIST_CAPABILITY,
  PAIRING_REDEEM_CAPABILITY,
  PAIRING_REVOKE_CAPABILITY,
  type DurableEvent,
  type EventEnvelope,
  type ProofEvent,
  type WorkspaceComposerPreference,
} from '@openmanager/protocol/node'
import {
  providers,
  type HostDeps,
  type ProviderBootstrap as RuntimeProviderBootstrap,
} from '@agentpack/runtime/node'
import { mountAgentRuntime } from './agent-runtime.ts'
import { createComposerService, desiredSessionConfig } from './composer-service.ts'
import { createDraftService } from './draft-service.ts'
import { openComposerStore } from './composer-store.ts'
import { openEnvironmentSettings } from './environment-settings.ts'
import { createTitleGenerator } from './session-titles/generator.ts'
import { createFilesystemService } from './filesystem.ts'
import { auditValue, createAuditLog } from './audit.ts'
import type { ServerConfig } from './config.ts'
import { validateHosts, validateOrigins, validateWorkspaceRoots } from './config.ts'
import { openAuthorizedClients } from './authorized-clients.ts'
import {
  createPairingService,
  GRANT_CHANGED_CLOSE_CODE,
  GRANT_CHANGED_CLOSE_REASON,
} from './pairing.ts'
import { createClientService, type ClientSockets } from './client-service.ts'
import { loadEnvironmentIdentity } from './identity.ts'
import {
  evaluateLocalOwnerAccess,
  evaluateLocalOwnerRouteAccess,
  LOCAL_OWNER_CLAIM_HEADER,
  LOCAL_OWNER_PATH,
} from './local-owner.ts'
import { createPersistentEventService } from './event-service.ts'
import { openEnvironmentDatabase } from './db/database.ts'
import { createEventRetention } from './db/event-retention.ts'
import { createReplayReader } from './db/replay.ts'
import { getSessionSummary } from './db/session-store.ts'
import { createLogger, resolveLogSink } from './logger.ts'
import { createProviderService } from './provider-service.ts'
import { createRateLimiter } from './rate-limit.ts'
import { createRequestGuard } from './request-guard.ts'
import { createThreadService, type WorkspaceRuntimeResolver } from './thread-service.ts'
import { createArtifactStore } from './artifacts.ts'
import { createUploadService } from './uploads.ts'
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
  COMPOSER_EVENTS_CAPABILITY,
  'session.list',
  'session.create',
  SESSION_CREATE_EXPLICIT_CAPABILITY,
  'session.open',
  'session.rename',
  'session.delete',
  'session.title.regenerate',
  'session.settle',
  'session.acknowledge',
  'session.background.stop',
  'session.history',
  'turn.send',
  'turn.interrupt',
  'interaction.respond',
  PLAN_BUILD_CAPABILITY,
  'workspace.list',
  'workspace.add',
  'workspace.remove',
  'workspace.icon',
  UPLOAD_TICKET_CAPABILITY,
  FILESYSTEM_BROWSE_CAPABILITY,
  ENVIRONMENT_SETTINGS_GET_CAPABILITY,
  ENVIRONMENT_SETTINGS_SET_CAPABILITY,
  DRAFT_LIST_CAPABILITY,
  DRAFT_SAVE_CAPABILITY,
  DRAFT_DELETE_CAPABILITY,
  PAIRING_CREATE_CAPABILITY,
  PAIRING_LIST_CAPABILITY,
  PAIRING_REVOKE_CAPABILITY,
  PAIRING_REDEEM_CAPABILITY,
  PAIRING_EXCHANGE_CAPABILITY,
  CLIENT_LIST_CAPABILITY,
  CLIENT_RENAME_CAPABILITY,
  CLIENT_REVOKE_CAPABILITY,
  CLIENT_REVOKE_OTHERS_CAPABILITY,
  CLIENT_OWNER_ROTATE_CAPABILITY,
]

/** A loopback-only listener exposing public liveness and connection discovery. */
export async function startServer(config: ServerConfig) {
  const allowedOrigins = validateOrigins(config.allowedOrigins ?? [])
  const allowedHosts = validateHosts(config.allowedHosts ?? [])
  const workspaceRoots = validateWorkspaceRoots(config.workspaces ?? [])
  const log = createLogger(config.logLevel, resolveLogSink(config.logFile))
  const rateLimiter = createRateLimiter()
  const identity = await loadEnvironmentIdentity(config.dataDir)
  const audit = createAuditLog(log, { dataDir: config.dataDir })
  const composerStore = openComposerStore(config.dataDir)
  const environmentSettings = openEnvironmentSettings(config.dataDir)
  const filesystem = createFilesystemService({ settings: environmentSettings })
  let announceClients: () => void = () => undefined
  const clients = openAuthorizedClients(config.dataDir, Date.now, audit, () => announceClients())
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
  let emitWorkspaceEvent: (event: ProofEvent) => void = () => undefined
  let closeWorkspaceSessions: (workspaceId: string) => void = () => undefined
  let availableProviders: () => readonly string[] = () => []
  let runnableProviders: () => readonly string[] = () => []
  let workspaces
  try {
    workspaces = openWorkspaceRegistry(config.dataDir, workspaceRoots, audit, {
      events: {
        environmentId: identity.environmentId,
        emit: (event) => emitWorkspaceEvent(event),
      },
      onUnregister: (workspaceId) => closeWorkspaceSessions(workspaceId),
      availableProviders: () => availableProviders(),
    })
  } catch (error) {
    composerStore.close()
    environmentSettings.close()
    clients.close()
    audit.close()
    throw error
  }
  // Production routes every workspace through the registry: an ID resolves to
  // its canonical root or to nothing. The test seam may substitute a provider.
  const resolveWorkspace: WorkspaceRuntimeResolver =
    config.resolveWorkspace ??
    ((workspaceId, context) => {
      const workspace = workspaces.resolve(workspaceId, context)
      if (!workspace) return undefined
      return {
        providerId: 'opencode',
        providers: runnableProviders(),
        cwd: workspace.root,
        // "Last used" means a session actually started here, not merely was
        // asked for. The stamp is bookkeeping: a failure is logged, never fatal.
        onSessionStarted: () => {
          try {
            workspaces.markUsed(workspace.workspaceId)
          } catch (error) {
            log('warn', 'workspace last-used stamp failed', {
              workspaceId: workspace.workspaceId,
              reason: error instanceof Error ? error.message : 'unknown',
            })
          }
        },
      }
    })
  let onRuntimeEvent: HostDeps['emitEvent'] = () => undefined
  // Until the composer service exists only the workspace preference can answer.
  let desiredConfigFor: NonNullable<HostDeps['desiredSessionConfig']> = ({
    providerId,
    workspacePath,
  }) => desiredSessionConfig(composerStore.getPreference(workspacePath, providerId))
  const runtime = mountAgentRuntime(
    log,
    (event) => onRuntimeEvent(event),
    (args) => desiredConfigFor(args),
    config.runtimeOptions,
  )
  let observeProviderCatalog: (providerId: string, result: RuntimeProviderBootstrap) => void = () =>
    undefined
  const providerService = createProviderService(
    runtime,
    providers,
    (providerId, result) => observeProviderCatalog(providerId, result),
    resolveWorkspace,
  )
  // Cheap capability input for workspace listings: a provider counts as
  // available when a session could start with it now (D9, no probing).
  availableProviders = () =>
    providerService
      .snapshot()
      .filter(({ health }) => health.summary === 'ready' || health.summary === 'warning')
      .map(({ id }) => id)
  // Broader than the listing: an unprobed provider is still runnable, so an
  // explicit create only fails for a provider the server would reject anyway.
  runnableProviders = () =>
    providerService
      .snapshot()
      .filter(({ id }) => providerService.rejection(id) === undefined)
      .map(({ id }) => id)
  let publishDurableEvent: (record: DurableEvent) => void = () => undefined
  let publishThreadEvent: (event: EventEnvelope) => void = () => undefined
  // Bound once the thread service exists, which the event service predates.
  let sessionProvider: (sessionId: string) => string | undefined = () => undefined
  const eventDatabase = openEnvironmentDatabase(config.dataDir)
  // One epoch per process for streams that start here; replay reads it for
  // scopes that have no stream row yet.
  const eventEpoch = randomUUID()
  const eventService = createPersistentEventService(
    eventDatabase,
    (record) => {
      // Thread dispatch persists synchronously; its response must precede events on the socket.
      if (record.event.name.startsWith('workspace.')) publishDurableEvent(record)
      else queueMicrotask(() => publishDurableEvent(record))
    },
    {
      epoch: eventEpoch,
      // The row names the provider the session was created on. The thread
      // service knows it while the create is still announcing the session; the
      // workspace default only stands in when no service is creating one.
      sessionProviderId: (session) => {
        const created = sessionProvider(session.sessionId)
        if (created) return created
        const target = resolveWorkspace(session.workspaceId)
        if (!target) throw new Error('Cannot persist session without a workspace provider')
        return target.providerId
      },
      onError: (error) => log('error', 'event persistence failed', { reason: String(error) }),
    },
  )
  const replayReader = createReplayReader(eventDatabase, {
    epoch: eventEpoch,
    environment: () => ({ environmentId: identity.environmentId, name: identity.label }),
    workspaces: () => workspaces.list(),
  })
  const stopRetention = createEventRetention(eventDatabase).schedule({
    onError: (error) => log('error', 'event retention failed', { reason: String(error) }),
  })
  // Health probes spawn a provider's CLI, which needs a real directory. No
  // client has to name one first: the registry already knows where the user
  // last worked. Every registry change is announced, so following the
  // announcements keeps this current as folders are added, used and removed.
  const syncProbeDirectory = () => {
    if (config.probeProviders) runtime.setDefaultProbeCwd(workspaces.mostRecent()?.root)
  }
  emitWorkspaceEvent = (event) => {
    eventService.append(event)
    syncProbeDirectory()
  }
  let recordSessionMode: (sessionId: string, modeId: string) => void = () => undefined
  let launchPreference: (
    workspaceId: string,
    providerId: string,
    picks?: WorkspaceComposerPreference,
  ) => WorkspaceComposerPreference = () => {
    throw new Error('The composer service is not ready.')
  }
  let seedSessionComposer: (
    sessionId: string,
    selection: Pick<WorkspaceComposerPreference, 'modelId' | 'configValues'>,
  ) => void = () => undefined
  const artifacts = createArtifactStore(eventDatabase, config.dataDir)
  const drafts = createDraftService({
    database: eventDatabase,
    environmentId: () => identity.environmentId,
    appendAtomic: (events) => eventService.appendAtomic(events),
  })
  try {
    drafts.pruneTombstones()
  } catch (error) {
    // Left for the next start; an old tombstone only refuses a stale save.
    log('error', 'old draft tombstones were not pruned', { reason: String(error) })
  }
  const titles =
    config.titleGenerator ??
    (config.generateTitles
      ? createTitleGenerator({
          setting: () => environmentSettings.get().titleGeneration,
          log: (level, message, data) => log(level, message, data),
        })
      : undefined)
  const threadService = createThreadService(
    runtime,
    providerService,
    (event) => eventService.append(event),
    (event) => publishThreadEvent(event),
    resolveWorkspace,
    {
      database: eventDatabase,
      artifacts,
      flush: eventService.flush,
      appendAtomic: (events) => eventService.appendAtomic(events),
      onPersistenceError: (error, eventName) =>
        log('error', 'event persistence failed', { eventName, reason: String(error) }),
      workspaceAvailability: (workspaceId) => workspaces.availability(workspaceId),
      onSessionMode: (sessionId, modeId) => recordSessionMode(sessionId, modeId),
      launchPreference: (workspaceId, providerId, picks) =>
        launchPreference(workspaceId, providerId, picks),
      seedSessionComposer: (sessionId, selection) => seedSessionComposer(sessionId, selection),
      drafts,
      ...(titles ? { titles } : {}),
      onTitleFailure: (sessionId, error) =>
        log('warn', 'session title was not generated', { sessionId, reason: String(error) }),
    },
  )
  sessionProvider = (sessionId) => threadService.providerForSession(sessionId)
  closeWorkspaceSessions = (workspaceId) => {
    // Flush before the registry cascades deletion of the projected thread rows.
    eventService.flush()
    threadService.closeWorkspaceSessions(workspaceId)
  }
  const composerService = createComposerService(
    runtime,
    providerService,
    composerStore,
    (sessionId) => threadService.resolveRuntimeSession(sessionId),
    {
      // Composer changes ride the environment stream, so every client sees
      // them live and a reconnect replays whatever it missed.
      publish: (name, payload) =>
        eventService.append({
          type: 'event',
          name,
          eventId: randomUUID(),
          timestamp: new Date().toISOString(),
          scope: { type: 'environment', environmentId: identity.environmentId },
          payload,
        } as ProofEvent),
      sessionForThread: (threadId) => threadService.sessionForThread(threadId),
      readSessionComposer: (sessionId) => getSessionSummary(eventDatabase, sessionId)?.composer,
    },
  )
  desiredConfigFor = (args) => composerService.desiredFor(args)
  recordSessionMode = (sessionId, modeId) => composerService.recordSessionMode(sessionId, modeId)
  launchPreference = (workspaceId, providerId, picks) =>
    composerService.launchPreference(workspaceId, providerId, picks)
  seedSessionComposer = (sessionId, selection) => composerService.seedSession(sessionId, selection)
  observeProviderCatalog = (providerId, result) => composerService.observeProbe(providerId, result)
  // Health probes answer to nobody, so nothing above would ever hear what
  // they learn. They are also the only probes a provider no client has opened
  // ever gets.
  runtime.onProviderCatalog((providerId, catalog) =>
    composerService.observeCatalog(providerId, catalog),
  )
  const uploads = createUploadService({
    artifacts,
    dataDir: config.dataDir,
    database: eventDatabase,
    audit,
    log,
    rateLimiter,
    authenticate: (credential) => clients.authenticate(credential),
    sessionWorkspace: (sessionId) => {
      // A session created a moment ago may still be in the write batch.
      eventService.flush()
      return getSessionSummary(eventDatabase, sessionId)?.workspaceId
    },
    resolveWorkspace,
  })
  let closeClientSockets: (clientId: string) => void = () => undefined
  const pairing = createPairingService({
    dataDir: config.dataDir,
    audit,
    rateLimiter,
    environment: () => ({ environmentId: identity.environmentId, label: identity.label }),
    onGrantChanged: (clientId) => closeClientSockets(clientId),
    onClientsChanged: () => announceClients(),
    onError: (error) => log('error', 'pairing exchange failed', { reason: String(error) }),
  })
  threadService.setEnvironmentId(identity.environmentId)
  try {
    threadService.forgetStaleBackgroundWork()
  } catch (error) {
    // Left for the next start; a stale "running" is wrong but harmless.
    log('error', 'stale background work was not cleared', { reason: String(error) })
  }
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
    if (request.method === 'OPTIONS' && path === LOCAL_OWNER_PATH) {
      const access = config.localOwnerClaimKey
        ? evaluateLocalOwnerRouteAccess(
            request,
            (server.address() as AddressInfo | null)?.port ?? config.port,
          )
        : 'not_found'
      if (access !== 'ok') {
        response.writeHead(access === 'forbidden' ? 403 : 404, {
          'cache-control': 'no-store',
        })
        response.end()
        return
      }
      response.writeHead(204, {
        'access-control-allow-methods': 'GET',
        'access-control-allow-headers': LOCAL_OWNER_CLAIM_HEADER,
        'access-control-max-age': '600',
        'cache-control': 'no-store',
      })
      response.end()
      return
    }
    if (uploads.handle(request, response)) return
    if (pairing.handle(request, response)) return
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
        config.localOwnerClaimKey,
      )
      if (access === 'not_found') {
        audit.record({
          type: 'owner.claim_denied',
          remoteAddress,
          details: { reason: 'not_local_claim', host: auditValue(request.headers.host) },
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
  let clientSockets: ClientSockets | undefined
  const clientService = createClientService({
    clients,
    sockets: () => {
      if (!clientSockets) throw new Error('The socket server is not ready.')
      return clientSockets
    },
    uploads,
    rotateOwner: (requestedBy) => {
      const previousId = owner.clientId
      const minted = clients.remintOwner()
      owner = minted.client
      // The rotation has committed: nothing after this may stop the caller
      // from cutting the old credential's sockets.
      try {
        audit.record({
          type: 'owner.reminted',
          clientId: minted.client.clientId,
          details: requestedBy
            ? { previousClientId: previousId, requestedBy }
            : { previousClientId: previousId },
        })
      } catch (error) {
        log('error', 'owner rotation was not audited', { reason: String(error) })
      }
      return { client: minted.client, credential: minted.credential, previousId }
    },
    log,
  })
  announceClients = () => clientService.announce()
  const sockets = attachWebSocket(server, {
    authenticate: (credential) => clients.authenticate(credential),
    guard,
    rateLimiter,
    audit,
    bootstrap,
    replay: (scope, cursor) => replayReader.read(scope, cursor),
    dispatchCommand: (command, context) =>
      workspaces.dispatch(command, context) ??
      threadService.dispatch(command, context) ??
      providerService.dispatch(command, context) ??
      uploads.dispatch(command, context) ??
      filesystem.dispatch(command, context) ??
      drafts.dispatch(command, context) ??
      pairing.dispatch(command, context) ??
      clientService.dispatch(command, context) ??
      composerService.dispatch(command),
    onConnectionsChanged: () => clientService.announce(),
  })
  clientSockets = sockets
  publishDurableEvent = (record) => sockets.publish(record)
  publishThreadEvent = (event) => sockets.publishEvent(event)
  closeClientSockets = (clientId) =>
    sockets.retireClient(clientId, GRANT_CHANGED_CLOSE_CODE, GRANT_CHANGED_CLOSE_REASON)
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
    clientService.stop()
    await sockets.close()
    stopHealthEvents()
    providerService.stop()
    composerService.stop()
    await runtime.shutdown()
    stopRetention()
    uploads.close()
    pairing.close()
    eventService.close()
    eventDatabase.close()
    composerStore.close()
    environmentSettings.close()
    clients.close()
    workspaces.close()
    audit.close()
    throw error
  }
  const address = server.address() as AddressInfo
  websocketUrl = `ws://127.0.0.1:${address.port}/ws`
  syncProbeDirectory()
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
    environmentSettings,
    uploads,
    pairing,
    sockets,
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
    /** Revoke a client's credential and cut its live sockets in one step. */
    revokeClient(clientId: string): boolean {
      if (clientId === owner.clientId) return false
      return clientService.revoke(clientId)
    },
    /**
     * Replace the owner credential. The previous owner row is revoked and its
     * live sockets close; the new credential is published in the data directory.
     */
    remintOwner() {
      const { client, credential } = clientService.rotateOwner()
      return { client, credential }
    },
    close: () => {
      if (!closePromise) {
        clientService.stop()
        const socketClose = sockets.close()
        // Before the listener: an in-flight PUT is cut and its partial file removed.
        uploads.close()
        // Before the store closes: a pending model lookup retry must not fire into it.
        composerService.stop()
        const httpClose = new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()))
          server.closeAllConnections()
        })
        closePromise = Promise.all([
          socketClose,
          httpClose,
          runtime.shutdown(),
          threadService.stopTitles(),
        ]).then(() => {
          stopRetention()
          pairing.close()
          eventService.close()
          eventDatabase.close()
          composerStore.close()
          environmentSettings.close()
          clients.close()
          workspaces.close()
          audit.close()
        })
        stopHealthEvents()
        providerService.stop()
      }
      return closePromise
    },
  }
}
