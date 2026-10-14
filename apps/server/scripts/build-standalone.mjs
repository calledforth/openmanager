#!/usr/bin/env node
/**
 * Build the self-contained `openmanager` executable for this machine's
 * platform and pack it into the release archive (docs/RELEASING.md).
 *
 *   node scripts/build-standalone.mjs [--out <dir>]
 *
 * 1. Bundle src/main.ts and every dependency into one ES module (esbuild).
 * 2. Wrap it in a Node single-executable application with `node --build-sea`,
 *    which copies the Node running this script. That Node is the runtime every
 *    user gets, so CI pins it (release-server.yml); it must be 25.7 or newer.
 * 3. Check the executable reports this version, then archive it as
 *    openmanager-<version>-<platform>-<arch>.zip (Windows) or .tar.gz (Linux).
 *
 * Run `pnpm --filter @openmanager/server build` first: the bundle reads the
 * workspace packages' built output.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outArg = process.argv.indexOf('--out')
const outDir = resolve(
  outArg === -1 ? join(serverDir, 'dist-standalone') : process.argv[outArg + 1],
)
const { version } = JSON.parse(readFileSync(join(serverDir, 'package.json'), 'utf8'))

const TARGETS = { 'win32-x64': 'zip', 'linux-x64': 'tar.gz', 'linux-arm64': 'tar.gz' }
const target = `${process.platform}-${process.arch}`
if (!(target in TARGETS)) fail(`No release target for ${target}.`)

const [major, minor] = process.versions.node.split('.').map(Number)
if (major < 25 || (major === 25 && minor < 7)) {
  fail(`--build-sea needs Node 25.7 or newer; this is ${process.versions.node}.`)
}

function fail(message) {
  console.error(`[build-standalone] ${message}`)
  process.exit(1)
}

function run(file, args, options = {}) {
  const result = spawnSync(file, args, { encoding: 'utf8', ...options })
  if (result.status !== 0) {
    fail(`${file} ${args.join(' ')} failed:\n${result.stderr || result.stdout || result.error}`)
  }
  return result.stdout
}

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
const bundle = join(outDir, 'openmanager.mjs')
const executable = join(outDir, process.platform === 'win32' ? 'openmanager.exe' : 'openmanager')

await build({
  entryPoints: [join(serverDir, 'src', 'main.ts')],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  logLevel: 'warning',
  define: { __OPENMANAGER_VERSION__: JSON.stringify(version) },
  // CommonJS dependencies call require(); an ES module bundle has none.
  banner: {
    js: "import { createRequire as __openmanagerRequire } from 'node:module'; const require = __openmanagerRequire(import.meta.url);",
  },
  external: [
    // Optional native speedups ws loads inside try/catch.
    'bufferutil',
    'utf-8-validate',
    // The Claude SDK's own per-platform CLI; the server runs the user's `claude`.
    '@anthropic-ai/claude-agent-sdk-*',
  ],
})

const seaConfig = join(outDir, 'sea-config.json')
writeFileSync(
  seaConfig,
  JSON.stringify({
    main: bundle,
    mainFormat: 'module',
    output: executable,
    disableExperimentalSEAWarning: true,
    // Code cache breaks import() and is tied to the build machine.
    useCodeCache: false,
    useSnapshot: false,
  }),
)
run(process.execPath, ['--build-sea', seaConfig])

const reported = run(executable, ['--version']).trim()
if (reported !== version) fail(`The executable reports ${reported}, expected ${version}.`)

const archive = join(outDir, `openmanager-${version}-${target}.${TARGETS[target]}`)
const name = process.platform === 'win32' ? 'openmanager.exe' : 'openmanager'
if (process.platform === 'win32') {
  // System32's bsdtar writes zip with -a; Git's GNU tar on PATH cannot.
  const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
  run(tar, ['-a', '-cf', archive, '-C', outDir, name])
} else {
  run('tar', ['-czf', archive, '-C', outDir, name])
}
rmSync(bundle)
rmSync(seaConfig)

const sha256 = createHash('sha256').update(readFileSync(archive)).digest('hex')
console.log(`[build-standalone] ${archive}`)
console.log(`[build-standalone] sha256 ${sha256}`)
console.log(`[build-standalone] Node ${process.versions.node} embedded`)
