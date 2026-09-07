import { spawn } from 'node:child_process'
import process from 'node:process'

const WEB_ORIGINS = 'http://localhost:5173,http://127.0.0.1:5173'
const pnpmBin = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

const children = []
let shuttingDown = false
let exitCode = 0

function start(label, args, extraEnv = {}) {
  const child = spawn(pnpmBin, args, {
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
  })
  child.on('exit', (code, signal) => {
    if (shuttingDown) {
      maybeFinish()
      return
    }
    shuttingDown = true
    if (signal || (code ?? 0) !== 0) {
      exitCode = code ?? 1
      console.error(`[dev:web] ${label} exited (${signal ?? `code ${code}`}); stopping the other process.`)
    }
    stopAll()
    maybeFinish()
  })
  child.on('error', (error) => {
    if (!shuttingDown) {
      shuttingDown = true
      exitCode = 1
      console.error(`[dev:web] failed to start ${label}:`, error)
      stopAll()
    }
    maybeFinish()
  })
  children.push(child)
}

function stopAll(signal = 'SIGTERM') {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill(signal)
    }
  }
}

function maybeFinish() {
  if (children.some((child) => child.exitCode === null && child.signalCode === null)) {
    return
  }
  process.exit(exitCode)
}

function onInterrupt() {
  if (shuttingDown) {
    return
  }
  shuttingDown = true
  stopAll()
  setTimeout(() => process.exit(exitCode), 2000).unref()
}

process.on('SIGINT', onInterrupt)
process.on('SIGTERM', onInterrupt)

console.log('[dev:web] starting environment server (http://127.0.0.1:43120) and web (http://127.0.0.1:5173)')

start(
  'server',
  ['--filter', '@openmanager/server', 'dev'],
  { OPENMANAGER_ALLOWED_ORIGINS: WEB_ORIGINS },
)
start('web', ['--filter', '@openmanager/web', 'dev'])
