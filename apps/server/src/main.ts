import { loadConfig } from './config.ts'
import { createLogger } from './logger.ts'
import { startServer } from './server.ts'

async function main(): Promise<void> {
  const config = loadConfig()
  const log = createLogger(config.logLevel)
  const server = await startServer(config)
  log('info', `Environment server listening on ${server.url}`)
  let stopping = false
  const stop = () => {
    if (stopping) return
    stopping = true
    void server.close().catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : 'Server shutdown failed.')
      process.exitCode = 1
    })
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}

main().catch((error: unknown) => {
  // Configuration/startup failures must remain visible even with silent logging.
  console.error(error instanceof Error ? error.message : 'Server startup failed.')
  process.exitCode = 1
})
