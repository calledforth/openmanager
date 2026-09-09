import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  BootstrapResponseSchema,
  PROTOCOL_VERSION,
  PROVIDER_DISCOVERY_CAPABILITY,
  PROVIDER_HEALTH_CAPABILITY,
  PROVIDER_PROBE_CAPABILITY,
} from '@openmanager/protocol/node'
import { mountAgentRuntime } from './agent-runtime.ts'
import type { ServerConfig } from './config.ts'
import { validateOrigins } from './config.ts'
import { loadClientToken } from './credential.ts'
import { loadEnvironmentIdentity } from './identity.ts'
import { createLogger } from './logger.ts'
import { createProviderService } from './provider-service.ts'
import { attachWebSocket, SOCKET_CAPABILITIES } from './websocket.ts'

export const SERVER_CAPABILITIES = [
  ...SOCKET_CAPABILITIES,
  PROVIDER_DISCOVERY_CAPABILITY,
  PROVIDER_HEALTH_CAPABILITY,
  PROVIDER_PROBE_CAPABILITY,
]

/** A loopback-only listener exposing public liveness and connection discovery. */
export async function startServer(config: ServerConfig) {
  const allowedOrigins = validateOrigins(config.allowedOrigins ?? [])
  const identity = await loadEnvironmentIdentity(config.dataDir)
  const token = await loadClientToken(config.dataDir)
  const runtime = mountAgentRuntime(createLogger(config.logLevel))
  const providerService = createProviderService(runtime)
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
    dispatchCommand: (command) => providerService.dispatch(command),
  })
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
    throw error
  }
  const address = server.address() as AddressInfo
  websocketUrl = `ws://127.0.0.1:${address.port}/ws`
  providerService.start()
  let closePromise: Promise<void> | undefined
  return {
    identity,
    runtime,
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
        closePromise = Promise.all([socketClose, httpClose, runtime.shutdown()]).then(() => {})
        stopHealthEvents()
        providerService.stop()
      }
      return closePromise
    },
  }
}
