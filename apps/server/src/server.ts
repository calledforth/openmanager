import { mkdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ServerConfig } from './config.ts'

/** A loopback-only listener; product routes and authentication arrive separately. */
export async function startServer(config: ServerConfig) {
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 })
  const server = createServer((_request, response) => {
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
  return {
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
