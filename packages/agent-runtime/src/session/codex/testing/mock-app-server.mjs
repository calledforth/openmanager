#!/usr/bin/env node
// A stand-in for `codex app-server` as a real child process, for tests of
// spawning, pipes, signals and exit codes, which an in-process fake cannot
// show. No dependencies: it is spawned with plain `node`.
//
//   node mock-app-server.mjs [-c key=value]... app-server
//
// The arguments `spawnCodexAppServer` passes (`-c` overrides, `app-server`)
// are accepted and ignored, so a test spawns it with
// `executable: { command: process.execPath, … }` and the script path as the
// first argument (see `codexMockSpawn` in the tests).
//
// Driven by the environment:
//
//   CODEX_MOCK_FIXTURE        A fixture to replay (format: fixture.ts). The
//                             same walk as ReplayCodexAppServer: server lines
//                             are played when reached, client lines wait for a
//                             matching message (by method, in order; answers by
//                             server request id), recorded answers go back
//                             under the client's ids, and an `exit` without
//                             `cause: "client"` is played as a crash.
//   CODEX_MOCK_USER_AGENT     With no fixture: the `initialize.userAgent` to
//                             answer with. Every other request gets -32601.
//   CODEX_MOCK_IGNORE_SIGTERM `1` to ignore SIGTERM, so a test can watch the
//                             termination ladder escalate to SIGKILL.
//
// Like Codex, it exits when stdin closes.

import { readFileSync } from 'node:fs'

if (process.env.CODEX_MOCK_IGNORE_SIGTERM === '1') process.on('SIGTERM', () => undefined)

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)

const fixturePath = process.env.CODEX_MOCK_FIXTURE
const entries = fixturePath ? parseFixture(readFileSync(fixturePath, 'utf8')) : undefined

let cursor = 0
const inbox = []
const ids = new Map()

function parseFixture(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '')
  return lines.slice(1).map((line) => JSON.parse(line))
}

const isRequest = (m) => m.id !== undefined && typeof m.method === 'string'
const isNotification = (m) => m.id === undefined && typeof m.method === 'string'
const isResponse = (m) => m.id !== undefined && m.method === undefined

function matches(recorded, actual) {
  if (isRequest(recorded)) return isRequest(actual) && actual.method === recorded.method
  if (isNotification(recorded)) return isNotification(actual) && actual.method === recorded.method
  return isResponse(actual) && String(actual.id) === String(recorded.id)
}

function advance() {
  while (cursor < entries.length) {
    const entry = entries[cursor]
    if (entry.from === 'client') {
      const index = inbox.findIndex((actual) => matches(entry.message, actual))
      if (index === -1) return
      const [actual] = inbox.splice(index, 1)
      if (isRequest(entry.message)) ids.set(String(entry.message.id), actual.id)
      cursor++
      continue
    }
    cursor++
    if (entry.message) {
      const message = entry.message
      send(isResponse(message) ? { ...message, id: ids.get(String(message.id)) ?? message.id } : message)
    } else if (entry.stderr !== undefined) process.stderr.write(`${entry.stderr}\n`)
    else if (entry.raw !== undefined) process.stdout.write(`${entry.raw}\n`)
    else if (entry.exit && entry.exit.cause !== 'client') {
      crash(entry.exit)
      return
    }
  }
}

/** Exit once stdout and stderr have been handed to the OS, so the last lines
 * (the panic) reach the client. */
function crash({ code, signal }) {
  let flushed = 0
  const done = () => {
    if (++flushed < 2) return
    if (signal) process.kill(process.pid, signal)
    else process.exit(code ?? 1)
  }
  process.stdout.write('', done)
  process.stderr.write('', done)
}

function receive(message) {
  if (entries) {
    if (cursor >= entries.length) {
      if (isRequest(message))
        send({ id: message.id, error: { code: -32601, message: `replay: ${message.method} is not in the recording` } })
      return
    }
    inbox.push(message)
    advance()
    return
  }
  if (!isRequest(message)) return
  if (message.method === 'initialize') {
    const name = message.params?.clientInfo?.name ?? 'OpenManager'
    send({
      id: message.id,
      result: {
        userAgent: process.env.CODEX_MOCK_USER_AGENT ?? `${name}/0.170.0 (Mock; x86_64) mock (${name}; 0.0.0)`,
        codexHome: '/home/user/.codex',
        platformFamily: 'unix',
        platformOs: 'linux',
      },
    })
    return
  }
  send({ id: message.id, error: { code: -32601, message: `mock codex app-server: ${message.method} is not scripted` } })
}

let buffered = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffered += chunk
  for (let nl = buffered.indexOf('\n'); nl !== -1; nl = buffered.indexOf('\n')) {
    const line = buffered.slice(0, nl)
    buffered = buffered.slice(nl + 1)
    if (!line.trim()) continue
    try {
      receive(JSON.parse(line))
    } catch (error) {
      process.stderr.write(`mock codex app-server: bad line from client: ${error}\n`)
    }
  }
})
process.stdin.on('end', () => process.exit(0))

if (entries) advance()
