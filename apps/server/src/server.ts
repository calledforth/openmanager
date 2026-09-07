import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { BootstrapResponseSchema, PROTOCOL_VERSION } from '@openmanager/protocol/node'
import type { ServerConfig } from './config.ts'
import { loadEnvironmentIdentity } from './identity.ts'

/** A loopback-only listener exposing public liveness and connection discovery. */
export async function startServer(config: ServerConfig) {
  const identity = await loadEnvironmentIdentity(config.dataDir)
  // Set after listen so port 0 advertises the actual port selected by the OS.
  let websocketUrl: string
  const bootstrap = () =>
    JSON.stringify(
      BootstrapResponseSchema.parse({
        environmentId: identity.environmentId,
        label: identity.label,
        protocolVersion: PROTOCOL_VERSION,
        capabilities: [],
        websocketUrl,
      }),
    )
  const server = createServer((request, response) => {
    const path = request.url?.split('?')[0]
    if (request.method === 'GET' && (path === '/health' || path === '/bootstrap')) {
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      response.end(path === '/health' ? JSON.stringify({ status: 'ok' }) : bootstrap())
      return
    }
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('Not found\n')
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const address = server.address() as AddressInfo
  websocketUrl = `ws://127.0.0.1:${address.port}/ws`
  return {
    identity,
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
        // No streaming or upgraded connections exist in the scaffold yet.
        server.closeAllConnections()
      }),
  }
}
