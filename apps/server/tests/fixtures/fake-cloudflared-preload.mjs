// Loaded with `--import` into an environment server started as its own
// process, where the in-process `spawn` seam is out of reach: the server
// runs the fake connector for whatever `cloudflared` it was pointed at.
//
// FAKE_CLOUDFLARED_RECORD: passed on to the fake, which logs its PID there
// FAKE_SERVER_CRASH: when set, the server throws an uncaught error as soon
//   as the fake has started, as a bug in any callback would
/* global process, setInterval, clearInterval, URL */
import { existsSync, readFileSync } from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { fileURLToPath } from 'node:url'

const fake = fileURLToPath(new URL('./fake-cloudflared.mjs', import.meta.url))
const record = process.env.FAKE_CLOUDFLARED_RECORD
const childProcess = createRequire(import.meta.url)('node:child_process')
const spawn = childProcess.spawn
childProcess.spawn = (file, args, options) =>
  /cloudflared(\.exe)?$/i.test(String(file))
    ? spawn(process.execPath, [fake, ...args], {
        ...options,
        env: { ...options?.env, ...(record ? { FAKE_CLOUDFLARED_RECORD: record } : {}) },
      })
    : spawn(file, args, options)
// The server's `import { spawn } from 'node:child_process'` sees the swap.
syncBuiltinESMExports()

if (process.env.FAKE_SERVER_CRASH && record) {
  const timer = setInterval(() => {
    // A whole line: the fake has written its PID.
    if (!existsSync(record) || !readFileSync(record, 'utf8').endsWith('\n')) return
    clearInterval(timer)
    throw new Error('crash probe')
  }, 20)
}
