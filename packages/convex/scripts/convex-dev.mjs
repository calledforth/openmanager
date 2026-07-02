import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')
const workspaceRoot = resolve(packageRoot, '../..')
const envFile = resolve(workspaceRoot, '.env.local')
const require = createRequire(import.meta.url)
// The convex package's "exports" map hides bin/main.js, so resolve the
// package root via package.json and join the bin path manually.
const convexPackageJson = require.resolve('convex/package.json')
const convexBin = resolve(dirname(convexPackageJson), 'bin/main.js')

const child = spawn(
  process.execPath,
  [convexBin, 'dev', `--env-file=${envFile}`, ...process.argv.slice(2)],
  {
    cwd: packageRoot,
    stdio: 'inherit',
  },
)

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 0)
})
