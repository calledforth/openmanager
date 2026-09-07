import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import process from 'node:process'
import { test } from 'node:test'
import { isolatedSpawnOptions, pnpmCommand, stopProcessTree } from './dev-web.mjs'

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('Windows launches pnpm through a shell; POSIX uses a process group', () => {
  const options = isolatedSpawnOptions({ OPENMANAGER_ALLOWED_ORIGINS: 'http://127.0.0.1:5173' })
  assert.equal(options.shell, process.platform === 'win32')
  assert.equal(options.detached, process.platform !== 'win32')
  assert.equal(pnpmCommand(), process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm')
})

test('stopProcessTree terminates nested child processes', async () => {
  const script = `
    const { spawn } = require('node:child_process')
    const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    })
    process.send({ grandchild: grandchild.pid })
    setInterval(() => {}, 1000)
  `
  const child = spawn(process.execPath, ['-e', script], {
    env: process.env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    windowsHide: true,
  })
  const { grandchild } = await new Promise((resolve, reject) => {
    child.once('message', resolve)
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      reject(new Error(`child exited before sending pid (${signal ?? `code ${code}`})`))
    })
  })
  assert.ok(isAlive(child.pid))
  assert.ok(isAlive(grandchild))

  stopProcessTree(child)
  await new Promise((resolve) => child.once('exit', resolve))
  const deadline = Date.now() + 3000
  while (Date.now() < deadline && isAlive(grandchild)) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.equal(isAlive(grandchild), false)
})
