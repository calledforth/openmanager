import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const entry = fileURLToPath(new URL('../dist/main.js', import.meta.url))

it.each([
  ['compiled', entry],
  ['native TypeScript', fileURLToPath(new URL('../src/main.ts', import.meta.url))],
])(
  'runs the %s app without Electron or Convex and prints the actual bound port',
  async (_name, executable) => {
    const directory = await mkdtemp(join(tmpdir(), 'openmanager-cli-test-'))
    const env = { ...process.env }
    delete env.CONVEX_URL
    delete env.OPENMANAGER_PORT
    delete env.OPENMANAGER_DATA_DIR
    delete env.OPENMANAGER_LOG_LEVEL
    const child = spawn(process.execPath, [executable, '--port=0', '--data-dir', directory], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const exited = once(child, 'exit')
    let output = ''
    let errors = ''
    child.stderr.on('data', (chunk) => {
      errors += String(chunk)
    })
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)
    try {
      while (!/http:\/\/127\.0\.0\.1:\d+/.test(output)) {
        const [chunk] = await once(child.stdout, 'data', { signal: controller.signal })
        output += String(chunk)
      }
      const url = output.match(/http:\/\/127\.0\.0\.1:\d+/)![0]
      const response = await fetch(url)
      expect(response.status).toBe(404)
      expect(errors).toBe('')
    } finally {
      clearTimeout(timeout)
      child.kill('SIGTERM')
      const exit = await exited
      await rm(directory, { recursive: true, force: true })
      // Windows terminates the process directly; POSIX delivers our signal handler.
      if (process.platform !== 'win32') expect(exit).toEqual([0, null])
    }
  },
)

it('returns a failing exit code for invalid configuration even in silent mode', async () => {
  const child = spawn(process.execPath, [entry, '--port=invalid', '--log-level=silent'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let errors = ''
  child.stderr.on('data', (chunk) => {
    errors += String(chunk)
  })
  const [code] = await once(child, 'exit')
  expect(code).toBe(1)
  expect(errors).toContain('Port must be an integer')
})
