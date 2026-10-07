// A stand-in for `cloudflared tunnel run`, for the tunnel supervisor tests.
// It logs the lines the supervisor reads, serves `/ready` and `/config` on
// the metrics address, and takes orders on `/fake/*` so a test can make it
// lose its connections or crash.
//
// FAKE_CLOUDFLARED_MODE: ok (default) | invalid_token | rejected | never_ready
// FAKE_CLOUDFLARED_RECORD: file that gets one JSON line per start
// FAKE_CLOUDFLARED_ORIGIN: the port the default ingress points at
// FAKE_CLOUDFLARED_INGRESS: a whole `/config` body, as JSON
/* global process, setInterval, setTimeout */
import { appendFileSync } from 'node:fs'
import { createServer } from 'node:http'

// Like cloudflared on Windows, a log line nobody reads anymore is dropped,
// not fatal: a test that kills the server must not see the connector die
// of a broken pipe instead.
process.stdout.on('error', () => {})
process.stderr.on('error', () => {})

const mode = process.env.FAKE_CLOUDFLARED_MODE ?? 'ok'
const token = process.env.TUNNEL_TOKEN ?? ''
const log = (message, extra = {}) =>
  process.stderr.write(
    `${JSON.stringify({ level: 'info', message, time: new Date().toISOString(), ...extra })}\n`,
  )

if (mode === 'invalid_token') {
  process.stderr.write('Provided Tunnel token is not valid.\n')
  process.stderr.write("See 'cloudflared tunnel run --help'.\n")
  process.exit(127)
}

let ready = false
const origin = process.env.FAKE_CLOUDFLARED_ORIGIN ?? '8080'
const ingress = process.env.FAKE_CLOUDFLARED_INGRESS
  ? JSON.parse(process.env.FAKE_CLOUDFLARED_INGRESS)
  : {
      version: 3,
      config: {
        ingress: [
          { hostname: 'om.test', service: `http://127.0.0.1:${origin}` },
          { service: 'http_status:404' },
        ],
      },
    }

const server = createServer((request, response) => {
  const send = (status, body) => {
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  }
  if (request.url === '/ready') {
    return ready
      ? send(200, { status: 200, readyConnections: 1, connectorId: 'fake' })
      : send(503, { status: 503, readyConnections: 0, connectorId: 'fake' })
  }
  if (request.url === '/config') return send(200, ingress)
  if (request.url === '/fake/unready') {
    ready = false
    log('Connection terminated', { level: 'error' })
    return send(200, {})
  }
  if (request.url === '/fake/ready') {
    ready = true
    log('Registered tunnel connection')
    return send(200, {})
  }
  if (request.url === '/fake/reconfigure') {
    // The dashboard added a second service behind the tunnel.
    ingress.config.ingress.splice(1, 0, {
      hostname: 'files.test',
      service: 'http://127.0.0.1:3000',
    })
    log('Updated to new configuration', { version: 4 })
    return send(200, {})
  }
  if (request.url === '/fake/exit') {
    send(200, {})
    setTimeout(() => process.exit(1), 10)
    return undefined
  }
  return send(404, {})
})

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address()
  if (process.env.FAKE_CLOUDFLARED_RECORD) {
    appendFileSync(
      process.env.FAKE_CLOUDFLARED_RECORD,
      `${JSON.stringify({
        pid: process.pid,
        argv: process.argv.slice(2),
        token,
        env: Object.keys(process.env),
        metricsPort: port,
      })}\n`,
    )
  }
  log('Version 2026.10.0 (fake)')
  // Real cloudflared never prints its token; this line checks the supervisor
  // would not pass it on if it did.
  log(`Settings: map[token:${token}]`)
  log(`Starting metrics server on 127.0.0.1:${port}/metrics`)
  if (mode === 'rejected') {
    const reject = () => {
      process.stderr.write(
        `${JSON.stringify({ level: 'error', error: 'Failed to get tunnel', message: 'Register tunnel error from server side' })}\n`,
      )
    }
    reject()
    setInterval(reject, 200)
    return
  }
  if (mode === 'never_ready') return
  setTimeout(() => {
    ready = true
    log('Registered tunnel connection', { connIndex: 0, location: 'fake01' })
  }, 50)
})

process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))
