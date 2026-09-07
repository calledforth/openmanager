import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

export const WEB_ORIGINS = 'http://localhost:5173,http://127.0.0.1:5173'

export function pnpmCommand() {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
}

export function isolatedSpawnOptions(extraEnv = {}) {
  return {
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
    shell: process.platform === 'win32',
    detached: process.platform !== 'win32',
    windowsHide: true,
  }
}

export function stopProcessTree(child, signal = 'SIGTERM') {
  if (child.pid == null || child.exitCode !== null || child.signalCode !== null) {
    return
  }
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    return
  }
  try {
    process.kill(-child.pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      /* already gone */
    }
  }
}

function isExecutedDirectly() {
  const entry = process.argv[1]
  return Boolean(entry) && resolve(fileURLToPath(import.meta.url)) === resolve(entry)
}

function start(label, args, extraEnv = {}) {
  const child = spawn(pnpmCommand(), args, isolatedSpawnOptions(extraEnv))
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
    stopProcessTree(child, signal)
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

const children = []
let shuttingDown = false
let exitCode = 0

export function main() {
  process.on('SIGINT', onInterrupt)
  process.on('SIGTERM', onInterrupt)

  console.log('[dev:web] starting environment server (http://127.0.0.1:43120) and web (http://127.0.0.1:5173)')

  start(
    'server',
    ['--filter', '@openmanager/server', 'dev'],
    { OPENMANAGER_ALLOWED_ORIGINS: WEB_ORIGINS },
  )
  start('web', ['--filter', '@openmanager/web', 'dev'])
}

if (isExecutedDirectly()) {
  main()
}
