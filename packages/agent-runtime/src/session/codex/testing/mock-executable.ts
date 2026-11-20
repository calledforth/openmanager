import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CodexExecutable } from '../executable.js'
import { codexMockAppServerPath } from './fixture.js'

/** Write a `codex` launcher into `dir` that runs the mock app-server with this
 * Node, and describe it as a resolved `CodexExecutable`.
 *
 * `spawnCodexAppServer` runs `<command> [-c …] app-server` and has no room
 * for a script argument, so the mock gets a launcher of its own, as Codex
 * itself has on PATH: a shell script on POSIX, and on Windows a `.cmd` shim,
 * which goes through the same `shell: true` path a real npm-installed
 * `codex.cmd` does. `dir` should be a fresh temp directory. */
export function createCodexMockExecutable(dir: string): CodexExecutable {
  const node = process.execPath
  const script = codexMockAppServerPath()
  if (process.platform === 'win32') {
    const command = join(dir, 'codex.cmd')
    writeFileSync(command, `@"${node}" "${script}" %*\r\n`)
    return { command, source: 'env', needsShell: true }
  }
  const command = join(dir, 'codex')
  writeFileSync(command, `#!/bin/sh\nexec ${shellQuote(node)} ${shellQuote(script)} "$@"\n`)
  chmodSync(command, 0o755)
  return { command, source: 'env', needsShell: false }
}

function shellQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`
}
