#!/usr/bin/env node
// Record a `codex app-server` conversation as a replay fixture.
//
//   node packages/agent-runtime/scripts/record-codex-fixture.mjs <scenario>... [options]
//   node packages/agent-runtime/scripts/record-codex-fixture.mjs --list
//
// Options:
//   --model <id>      Model for every thread and turn. Default: DEFAULT_MODEL, the
//                     smallest the account offered when these were first recorded
//                     (check `model/list`); `--model default` leaves the choice to
//                     Codex.
//   --out <dir>       Where fixtures are written. Default: the committed fixtures
//                     directory, src/session/codex/testing/fixtures.
//   --keep-workspace  Leave the throwaway workspace on disk for a look afterwards.
//
// Runs the real Codex (`CODEX_BIN`, else `codex` on PATH) against the signed-in
// account in the user's own ~/.codex, in a fresh temp workspace, with low
// effort and tiny prompts. Threads are ephemeral, except where a subagent is
// spawned (that needs the parent's rollout on disk); those are archived once
// the recording is over. Every scenario spends real tokens: 14k to 60k input
// tokens (mostly cached) and under 100 output tokens with gpt-6-luna.
//
// To add a fixture: add a scenario below, record it, read the result (it is
// committed, so check what it says), add its name to CODEX_FIXTURES in
// fixture.ts and a replay test in ReplayCodexAppServer.test.ts that drives the
// client the way the scenario drove Codex.
//
// The fixture format (one JSON object per line) is documented in
// src/session/codex/testing/fixture.ts. In short: a header line, then every
// message in either direction, stderr line and the exit, in the order they
// happened, each with milliseconds since spawn. Before anything is written it
// is sanitised (home and workspace paths, account ids and emails, anything
// token-like) and then checked: a fixture that still contains the home
// directory, any user's home (`/Users/…`, `C:\Users\…`), the user or machine
// name, or an email address is refused, not written.
//
// No dependencies, so it runs with plain `node` and needs no build.

import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, hostname, tmpdir, userInfo } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeSanitizer } from './codex-fixture-sanitizer.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_OUT = resolve(HERE, '../src/session/codex/testing/fixtures')
const FORMAT = 'openmanager.codex-replay/1'
/** Not looked up with `model/list` at record time: its answer is ~10 KB that
 * every fixture would then carry and every replay would have to request. */
const DEFAULT_MODEL = 'gpt-6-luna'

/** A 1x1 red PNG: the image the `image-view` scenario shows the model, and
 * what the `image-generation` scenario keeps in place of the real one. */
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'

/** What openmanager's own client sends (CodexAppServerClient.initialize), so a
 * replay of the recording sees the handshake the real client makes. */
const INITIALIZE_CAPABILITIES = {
  experimentalApi: true,
  requestAttestation: false,
  optOutNotificationMethods: ['turn/diff/updated', 'remoteControl/status/changed'],
}

// ---------------------------------------------------------------------------
// Scenarios. Each one drives a live app-server through `session` (below) and
// is kept to the fewest, smallest turns that show the behaviour.

const SCENARIOS = {
  'simple-turn': {
    description: 'One thread, one short turn answered with text only.',
    async run(s) {
      const thread = await s.startThread()
      await s.runTurn(thread, 'Reply with exactly the word: pong')
    },
  },

  'command-approval': {
    description:
      'approvalPolicy untrusted: a shell command needs approval (item/commandExecution/requestApproval), accepted.',
    async run(s) {
      s.answer('item/commandExecution/requestApproval', () => ({ decision: 'accept' }))
      const thread = await s.startThread({ approvalPolicy: 'untrusted', sandbox: 'workspace-write' })
      await s.runTurn(thread, 'Use the shell to run exactly: mkdir made-by-codex\nThen reply "done". Do nothing else.', {
        approvalPolicy: 'untrusted',
      })
    },
  },

  'file-change-approval': {
    description:
      'Read-only sandbox, approvalPolicy on-request: an apply_patch edit needs approval (item/fileChange/requestApproval), accepted.',
    async run(s) {
      s.answer('item/commandExecution/requestApproval', () => ({ decision: 'accept' }))
      s.answer('item/fileChange/requestApproval', () => ({ decision: 'accept' }))
      const thread = await s.startThread({ approvalPolicy: 'on-request', sandbox: 'read-only' })
      await s.runTurn(
        thread,
        'Create the file hello.txt containing the single line "hi" using apply_patch. Then reply "done". Do nothing else.',
        { approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly', networkAccess: false } },
      )
    },
  },

  'permissions-approval': {
    description:
      'The request_permissions tool (feature request_permissions_tool) asks for write access (item/permissions/requestApproval), granted for the turn.',
    config: ['features.request_permissions_tool=true'],
    async run(s) {
      s.answer('item/permissions/requestApproval', (params) => ({
        permissions: params.permissions,
        scope: 'turn',
      }))
      s.answer('item/commandExecution/requestApproval', () => ({ decision: 'accept' }))
      s.answer('item/fileChange/requestApproval', () => ({ decision: 'accept' }))
      const thread = await s.startThread({ approvalPolicy: 'on-request', sandbox: 'read-only' })
      await s.runTurn(
        thread,
        'Before anything else, call the request_permissions tool to ask for write access to the current directory. After it answers, reply "done". Do nothing else.',
        { approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly', networkAccess: false } },
      )
    },
  },

  subagent: {
    description: 'The parent spawns one subagent, waits for it and reports its answer: child-thread notifications interleave with the parent\'s.',
    async run(s) {
      // Not ephemeral: spawning a child needs the parent's rollout on disk
      // ("no rollout found for thread id" otherwise).
      const thread = await s.startThread({ approvalPolicy: 'never', sandbox: 'read-only', ephemeral: false })
      s.archiveAfterwards(thread)
      await s.runTurn(
        thread,
        'Spawn exactly one subagent with the prompt "Reply with exactly: 42". Wait for it to finish, then reply with its answer and nothing else.',
        { approvalPolicy: 'never' },
      )
    },
  },

  'interrupt-with-child': {
    description:
      'The parent spawns a subagent that runs `sleep 30`; the parent turn is interrupted (turn/interrupt) while the child is still running, which leaves the child running, so the child is interrupted next: its notifications arrive after the parent turn ended.',
    async run(s) {
      const thread = await s.startThread({ approvalPolicy: 'never', sandbox: 'read-only', ephemeral: false })
      s.archiveAfterwards(thread)
      const turn = await s.startTurn(
        thread,
        'Spawn exactly one subagent with the prompt "Use the shell to run: sleep 30. Then reply done." and wait for it.',
        { approvalPolicy: 'never' },
      )
      const childTurn = s.waitFor((m) => m.method === 'turn/started' && m.params.threadId !== thread, 90_000)
      // Interrupt once the child is demonstrably running: its command started.
      const command = await s.waitFor(
        (m) =>
          m.method === 'item/started' &&
          m.params.threadId !== thread &&
          m.params.item?.type === 'commandExecution',
        90_000,
      )
      const child = command.params.threadId
      const childTurnId = (await childTurn).params.turn.id
      await s.request('turn/interrupt', { threadId: thread, turnId: turn })
      await s.turnCompleted(thread, turn)
      // Interrupting the parent does not stop the child (codex 0.170).
      const childDone = s.turnCompleted(child, childTurnId)
      await s.request('turn/interrupt', { threadId: child, turnId: childTurnId })
      await childDone
    },
  },

  'tool-items': {
    description:
      'One turn with a plan (turn/plan/updated), a read, a search and a listing through the shell (commandActions), a failing command, and an apply_patch edit (fileChange; a patch this small sends no patchUpdated).',
    setup(workspace) {
      writeFileSync(join(workspace, 'notes.txt'), 'hello world\nsecond line\n')
    },
    async run(s) {
      // `update_plan` is off unless a client turns it on (probed on 0.170);
      // openmanager does, on every thread.
      const thread = await s.startThread({
        approvalPolicy: 'never',
        sandbox: 'workspace-write',
        config: { notify: [], 'tools.update_plan.enabled': true },
      })
      await s.runTurn(
        thread,
        [
          'Do these steps in order, one tool call each, and nothing else:',
          '1. Call update_plan with two steps: "Look around" (in progress) and "Edit notes" (pending).',
          '2. Use the shell to run exactly: cat notes.txt',
          '3. Use the shell to run exactly: rg -n hello',
          '4. Use the shell to run exactly: ls',
          '5. Use the shell to run exactly: ls does-not-exist',
          '6. Use apply_patch to replace "hello world" with "goodbye world" in notes.txt.',
          '7. Call update_plan with both steps completed.',
          'Then reply "done".',
        ].join('\n'),
        { approvalPolicy: 'never', sandboxPolicy: { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false } },
      )
    },
  },

  'terminal-interaction': {
    description:
      'A command that waits on stdin, answered with write_stdin: item/commandExecution/terminalInteraction names the command it wrote to.',
    async run(s) {
      const thread = await s.startThread({
        approvalPolicy: 'never',
        sandbox: 'workspace-write',
        config: { notify: [], 'tools.update_plan.enabled': true },
      })
      await s.runTurn(
        thread,
        [
          'Use exec_command with tty enabled to start exactly: read -p "name? " n; echo "hi $n"',
          'It waits for input. Then use write_stdin to send "ada" followed by a newline to that session.',
          'Then reply "done". Do nothing else.',
        ].join('\n'),
        { approvalPolicy: 'never' },
      )
    },
  },

  'image-view': {
    description: 'The model looks at a small PNG in the workspace with view_image (an imageView item).',
    setup(workspace) {
      writeFileSync(join(workspace, 'dot.png'), Buffer.from(TINY_PNG, 'base64'))
    },
    async run(s) {
      const thread = await s.startThread({ approvalPolicy: 'never', sandbox: 'read-only' })
      await s.runTurn(
        thread,
        'Use the view_image tool to look at the file dot.png in the current directory, then reply with one word naming its main colour. Do nothing else.',
        { approvalPolicy: 'never' },
      )
    },
  },

  'image-generation': {
    description:
      'The model generates one image (an imageGeneration item, saved to a temporary file under the Codex home: savedPath). The base64 `result` is cut down to a tiny PNG before the fixture is written.',
    async run(s) {
      const thread = await s.startThread({ approvalPolicy: 'never', sandbox: 'read-only' })
      await s.runTurn(
        thread,
        'Generate one very small, simple image: a flat red circle on a white background. Then reply "done". Do nothing else.',
        { approvalPolicy: 'never' },
      )
    },
    /** A generated image's bytes are ~1 MB of base64 on every item that
     * carries them; the fixture keeps the shape with a tiny stand-in. */
    shrink(entry) {
      const item = entry.message?.params?.item
      if (item?.type === 'imageGeneration' && typeof item.result === 'string' && item.result.length > 0)
        item.result = TINY_PNG
      return entry
    },
  },

  steer: {
    description: 'A running turn receives more input through turn/steer and finishes as one turn.',
    async run(s) {
      const thread = await s.startThread({ approvalPolicy: 'never', sandbox: 'read-only' })
      const turn = await s.startTurn(
        thread,
        'Use the shell to run exactly: sleep 4\nThen reply "first".',
        { approvalPolicy: 'never' },
      )
      await s.waitFor(
        (m) => m.method === 'item/started' && m.params.threadId === thread && m.params.item?.type === 'commandExecution',
        60_000,
      )
      await s.request('turn/steer', {
        threadId: thread,
        expectedTurnId: turn,
        input: [{ type: 'text', text: 'Also add the word "second" to your reply.', text_elements: [] }],
      })
      await s.turnCompleted(thread, turn)
    },
  },
}

// ---------------------------------------------------------------------------
// The live session: a minimal JSON-RPC client that writes down everything.

class Session {
  constructor(child, entries, started, options) {
    this.child = child
    this.entries = entries
    this.started = started
    this.options = options
    this.nextId = 1
    this.pending = new Map()
    this.waiters = new Set()
    this.handlers = new Map([['currentTime/read', () => ({ currentTimeAt: Math.floor(Date.now() / 1000) })]])
    this.model = options.model
    /** Off once the scenario is over: tidying up is not part of the fixture. */
    this.recording = true
    this.cleanups = []
  }

  /** Archive a persisted thread once the recording is over, so recordings do
   * not pile up in the user's Codex history. */
  archiveAfterwards(threadId) {
    this.cleanups.push(() => this.request('thread/archive', { threadId }).catch(() => undefined))
  }

  /** Wire stdout into the session. */
  receive(message) {
    if (message.method !== undefined && message.id !== undefined) {
      void this.serverRequest(message)
      return
    }
    if (message.method === undefined && message.id !== undefined) {
      const entry = this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id)
      if (message.error) entry.reject(new Error(`${entry.method}: ${JSON.stringify(message.error)}`))
      else entry.resolve(message.result)
      return
    }
    for (const waiter of this.waiters) waiter(message)
  }

  async serverRequest(message) {
    const handler = this.handlers.get(message.method)
    if (!handler) {
      this.send({ id: message.id, error: { code: -32601, message: `recorder does not handle ${message.method}` } })
      return
    }
    this.send({ id: message.id, result: await handler(message.params) })
  }

  send(message) {
    if (this.recording) this.entries.push({ atMs: Date.now() - this.started, from: 'client', message })
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  request(method, params) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject })
      this.send(params === undefined ? { id, method } : { id, method, params })
    })
  }

  notify(method, params) {
    this.send(params === undefined ? { method } : { method, params })
  }

  answer(method, handler) {
    this.handlers.set(method, handler)
  }

  /** The next notification matching `predicate`. */
  waitFor(predicate, timeoutMs = 120_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(waiter)
        reject(new Error(`timed out after ${timeoutMs}ms waiting for a notification`))
      }, timeoutMs)
      const waiter = (message) => {
        if (!predicate(message)) return
        clearTimeout(timer)
        this.waiters.delete(waiter)
        resolve(message)
      }
      this.waiters.add(waiter)
    })
  }

  async startThread(overrides = {}) {
    const result = await this.request('thread/start', {
      cwd: this.options.workspace,
      ephemeral: true,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      config: { notify: [] },
      ...(this.model ? { model: this.model } : {}),
      ...overrides,
    })
    return result.thread.id
  }

  /** `turn/start` with the low-cost settings; resolves to the turn id. */
  async startTurn(threadId, text, overrides = {}) {
    const result = await this.request('turn/start', {
      threadId,
      input: [{ type: 'text', text, text_elements: [] }],
      effort: 'low',
      summary: 'detailed',
      ...(this.model ? { model: this.model } : {}),
      ...overrides,
    })
    return result.turn.id
  }

  turnCompleted(threadId, turnId, timeoutMs = 180_000) {
    return this.waitFor(
      (m) => m.method === 'turn/completed' && m.params.threadId === threadId && m.params.turn.id === turnId,
      timeoutMs,
    )
  }

  async runTurn(threadId, text, overrides = {}) {
    // Listen before starting: a fast turn can complete before `turn/start`
    // has even been answered.
    let turnId
    const completed = this.waitFor(
      (m) => m.method === 'turn/completed' && m.params.threadId === threadId && (turnId === undefined || m.params.turn.id === turnId),
      180_000,
    )
    turnId = await this.startTurn(threadId, text, overrides)
    await completed
    return turnId
  }
}

// ---------------------------------------------------------------------------
// Running one scenario

function codexCommand() {
  return process.env.CODEX_BIN || 'codex'
}

/** Start `codex <args>`. On Windows `codex` is usually npm's `codex.cmd` shim,
 * which Node runs only through a shell (since the CVE-2024-27980 fix), and a
 * shell takes one command line. Only a `CODEX_BIN` with spaces needs quoting:
 * the scenarios' own arguments are plain `-c key=value` words. */
function spawnCodex(args, options) {
  if (process.platform !== 'win32') return spawn(codexCommand(), args, options)
  for (const arg of args)
    if (/[\s"&|<>^()%!]/.test(arg)) throw new Error(`recorder: ${JSON.stringify(arg)} needs quoting for cmd.exe`)
  const command = /\s/.test(codexCommand()) ? `"${codexCommand()}"` : codexCommand()
  return spawn([command, ...args].join(' '), { ...options, shell: true, windowsHide: true })
}

async function record(name, options) {
  const scenario = SCENARIOS[name]
  const workspace = mkdtempSync(join(tmpdir(), 'codex-fixture-'))
  scenario.setup?.(workspace)
  const args = [...(scenario.config ?? []).flatMap((entry) => ['-c', entry]), 'app-server']
  const started = Date.now()
  const entries = []
  const child = spawnCodex(args, { cwd: workspace, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))
  child.on('error', (error) => {
    console.error(`could not start ${codexCommand()}: ${error.message}`)
    process.exit(1)
  })

  const session = new Session(child, entries, started, { ...options, workspace })
  lines(child.stdout, (line) => {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      if (session.recording) entries.push({ atMs: Date.now() - started, from: 'server', raw: line })
      return
    }
    if (session.recording) entries.push({ atMs: Date.now() - started, from: 'server', message })
    session.receive(message)
  })
  lines(child.stderr, (line) => {
    if (session.recording) entries.push({ atMs: Date.now() - started, from: 'server', stderr: line })
  })

  let initialize
  let failure
  try {
    initialize = await session.request('initialize', {
      clientInfo: { name: 'OpenManager', title: 'OpenManager', version: '0.0.0-fixture' },
      capabilities: INITIALIZE_CAPABILITIES,
    })
    session.notify('initialized')
    await scenario.run(session)
    // Whatever the server still says after the last turn (late item
    // completions, token usage, a child thread winding down) is part of the
    // behaviour being recorded.
    await new Promise((resolve) => setTimeout(resolve, 1500))
  } catch (error) {
    failure = error
  }
  session.recording = false
  for (const cleanup of session.cleanups) await cleanup()
  child.stdin.end()
  child.kill('SIGTERM')
  const exit = await exited
  // Let the pipes drain after `exit`.
  await new Promise((resolve) => setTimeout(resolve, 200))
  // The exit is the fixture's last word, recorded even though the stream
  // after the scenario (the cleanup) is not.
  // `cause: 'client'`: the recorder ended it (stdin closed, SIGTERM), so a
  // replay treats it as the end of the recording rather than a crash to play.
  entries.push({ atMs: Date.now() - started, from: 'server', exit: { ...exit, cause: 'client' } })
  if (!options.keepWorkspace) rmSync(workspace, { recursive: true, force: true })
  else console.error(`workspace kept at ${workspace}`)
  if (failure) throw failure

  const sanitize = makeSanitizer({
    workspace,
    home: homedir(),
    codexHome: initialize?.codexHome,
    user: userInfo().username,
    host: hostname(),
  })
  const header = {
    format: FORMAT,
    scenario: name,
    description: scenario.description,
    codexVersion: /\/(\d+\.\d+\.\d+)/.exec(initialize?.userAgent ?? '')?.[1] ?? 'unknown',
    model: session.model ?? null,
    recordedAt: new Date(started).toISOString().slice(0, 10),
    config: scenario.config ?? [],
    placeholders: { workspace: '/workspace', home: '/home/user', codexHome: '/home/user/.codex' },
  }
  const shrink = scenario.shrink ?? ((entry) => entry)
  const body = [header, ...entries.map((entry) => sanitize.entry(shrink(entry)))].map((line) => JSON.stringify(line)).join('\n') + '\n'
  const leaks = sanitize.leaks(body)
  if (leaks.length > 0) throw new Error(`refusing to write ${name}: still contains ${leaks.map((l) => JSON.stringify(l)).join(', ')}`)
  mkdirSync(options.out, { recursive: true })
  const file = join(options.out, `${name}.jsonl`)
  writeFileSync(file, body)
  const usage = tokenUsage(entries)
  console.error(
    `${name}: ${entries.length} entries in ${((Date.now() - started) / 1000).toFixed(1)}s -> ${file}` +
      (usage ? ` (tokens: ${usage.input} in, ${usage.cached} cached, ${usage.output} out)` : ''),
  )
}

/** Total token usage reported for the threads in a recording. */
function tokenUsage(entries) {
  const latest = new Map()
  for (const { message } of entries)
    if (message?.method === 'thread/tokenUsage/updated') latest.set(message.params.threadId, message.params.tokenUsage.total)
  if (latest.size === 0) return undefined
  const sum = { input: 0, cached: 0, output: 0 }
  for (const total of latest.values()) {
    sum.input += total.inputTokens
    sum.cached += total.cachedInputTokens
    sum.output += total.outputTokens
  }
  return sum
}

function lines(stream, onLine) {
  let buffered = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    buffered += chunk
    for (let nl = buffered.indexOf('\n'); nl !== -1; nl = buffered.indexOf('\n')) {
      const line = buffered.slice(0, nl).replace(/\r$/, '')
      buffered = buffered.slice(nl + 1)
      if (line) onLine(line)
    }
  })
  stream.on('end', () => {
    if (buffered) onLine(buffered)
  })
}

// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--list') || argv.length === 0) {
    for (const [name, { description }] of Object.entries(SCENARIOS)) console.log(`${name.padEnd(22)} ${description}`)
    return
  }
  const options = { out: DEFAULT_OUT, model: DEFAULT_MODEL, keepWorkspace: false }
  const names = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--out') options.out = resolve(argv[++i])
    else if (arg === '--model') {
      const model = argv[++i]
      options.model = model === 'default' ? undefined : model
    }
    else if (arg === '--keep-workspace') options.keepWorkspace = true
    else if (arg === '--all') names.push(...Object.keys(SCENARIOS))
    else if (SCENARIOS[arg]) names.push(arg)
    else throw new Error(`unknown scenario or option: ${arg} (try --list)`)
  }
  for (const name of names) await record(name, options)
}


// Run as a script, not when imported (to check the sanitiser by hand).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
