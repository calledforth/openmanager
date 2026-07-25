#!/usr/bin/env node
/* Live ACP probe against cursor-agent: log the exact ordering/classification of
   agent_message_chunk vs agent_thought_chunk vs tool_call around tool calls. */
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

// Point at the newest cursor-agent version dir (it ships its own node.exe; Node 22 can't
// spawn the .cmd shim directly, so we invoke `<ver>/node.exe <ver>/index.js acp`).
const VER =
  process.env.CURSOR_AGENT_VERSION_DIR ||
  'C:\\Users\\rajku\\AppData\\Local\\cursor-agent\\versions\\2026.07.23-e383d2b'
const CWD = process.env.PROBE_CWD || 'C:\\Users\\rajku\\OneDrive\\Documents\\ClePro\\openmanager'
const MODEL = process.env.PROBE_MODEL || ''
const PROMPT =
  process.env.PROBE_PROMPT ||
  'Read packages/agent-view/src/fold/foldEvents.ts and packages/agent-runtime/src/backends/acp/AcpBackend.ts, then grep for "agent_thought_chunk" across the repo, and tell me in 2 sentences how thinking chunks are folded into rows. Do not edit any files.'
const OUT = process.env.PROBE_OUT || path.join(__dirname, 'probe-raw.jsonl')

fs.writeFileSync(OUT, '')
const raw = fs.createWriteStream(OUT, { flags: 'a' })

const child = spawn(path.join(VER, 'node.exe'), [path.join(VER, 'index.js'), 'acp'], {
  cwd: CWD,
  stdio: ['pipe', 'pipe', 'pipe'],
})

let nextId = 1
const pending = new Map()
function send(method, params) {
  const id = nextId++
  const msg = { jsonrpc: '2.0', id, method, params }
  child.stdin.write(JSON.stringify(msg) + '\n')
  return new Promise((res, rej) => pending.set(id, { res, rej }))
}
function respond(id, result) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
}

// ---- transcript ----
const timeline = []
let t0 = Date.now()
function mark(kind, detail) {
  timeline.push({ ms: Date.now() - t0, kind, detail })
}

let buf = ''
child.stdout.on('data', (d) => {
  buf += d.toString()
  const lines = buf.split('\n')
  buf = lines.pop() || ''
  for (const line of lines) {
    const s = line.trim()
    if (!s) continue
    let msg
    try {
      msg = JSON.parse(s)
    } catch {
      continue
    }
    raw.write(JSON.stringify({ ms: Date.now() - t0, msg }) + '\n')
    handle(msg)
  }
})
child.stderr.on('data', (d) => process.stderr.write('[stderr] ' + d.toString()))

function textOf(content) {
  if (!content) return ''
  if (typeof content === 'string') return content
  if (content.type === 'text') return content.text ?? ''
  return `<${content.type}>`
}

function handle(msg) {
  if (msg.id !== undefined && msg.method) {
    // incoming request from agent
    const m = msg.method
    if (m === 'session/request_permission') {
      const opts = msg.params?.options ?? []
      const pick =
        opts.find((o) => o.kind === 'allow_always') ??
        opts.find((o) => o.kind === 'allow_once') ??
        opts[0]
      mark('PERMISSION', `${msg.params?.toolCall?.title} -> ${pick?.optionId}`)
      respond(msg.id, { outcome: { outcome: 'selected', optionId: pick?.optionId } })
      return
    }
    if (m === 'cursor/update_todos') {
      mark('EXT', 'cursor/update_todos')
      respond(msg.id, {})
      return
    }
    mark('EXT', m)
    respond(msg.id, {})
    return
  }
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
    const p = pending.get(msg.id)
    pending.delete(msg.id)
    if (p) (msg.error ? p.rej : p.res)(msg.error ?? msg.result)
    return
  }
  if (msg.method === 'session/update') {
    const u = msg.params?.update ?? {}
    const k = u.sessionUpdate
    if (k === 'agent_message_chunk') mark('MSG', textOf(u.content))
    else if (k === 'agent_thought_chunk') mark('THOUGHT', textOf(u.content))
    else if (k === 'tool_call') mark('TOOL_CALL', `${u.toolCallId} | ${u.title} | kind=${u.kind}`)
    else if (k === 'tool_call_update') mark('TOOL_UPD', `${u.toolCallId} | ${u.status ?? ''}`)
    else if (k === 'plan') mark('PLAN', JSON.stringify(u.entries ?? []).slice(0, 120))
    else if (k === 'usage_update') mark('USAGE', JSON.stringify(u).slice(0, 160))
    else mark(k?.toUpperCase() ?? 'UNKNOWN', JSON.stringify(u).slice(0, 120))
  }
}

;(async () => {
  await send('initialize', {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
  })
  const s = await send('session/new', { cwd: CWD, mcpServers: [] })
  const sessionId = s.sessionId
  console.error('session:', sessionId)
  console.error('modes:', JSON.stringify(s.modes))
  const modelOpt = (s.configOptions ?? []).find((o) => /model/i.test(o.id ?? o.name ?? ''))
  if (modelOpt) {
    console.error('current model:', JSON.stringify(modelOpt.currentValue ?? modelOpt.value))
    if (MODEL) {
      const r = await send('session/set_config_option', {
        sessionId,
        configId: modelOpt.id,
        value: MODEL,
      }).catch((e) => {
        console.error('SET MODEL FAILED', e)
        process.exit(1)
      })
      const now = (r.configOptions ?? []).find((o) => o.id === 'model')?.currentValue
      console.error('set model ->', now)
      if (now !== MODEL) {
        console.error('MODEL DID NOT STICK')
        process.exit(1)
      }
    }
  }

  t0 = Date.now()
  const res = await send('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: PROMPT }],
  })
  mark('STOP', JSON.stringify(res))

  // ---- report ----
  const merged = []
  for (const e of timeline) {
    const last = merged[merged.length - 1]
    if (last && last.kind === e.kind && (e.kind === 'MSG' || e.kind === 'THOUGHT')) {
      last.detail += e.detail
      last.chunks++
      last.endMs = e.ms
    } else {
      merged.push({ ...e, chunks: 1, endMs: e.ms })
    }
  }
  const lines = merged.map((e) => {
    const body =
      e.kind === 'MSG' || e.kind === 'THOUGHT'
        ? `(${e.chunks} chunks, ${e.endMs - e.ms}ms) ${JSON.stringify(e.detail)}`
        : e.detail
    return `[${String(e.ms).padStart(6)}ms] ${e.kind.padEnd(10)} ${body}`
  })
  fs.writeFileSync(path.join(__dirname, 'probe-timeline.txt'), lines.join('\n'))
  console.log(lines.join('\n'))
  child.kill()
  process.exit(0)
})().catch((e) => {
  console.error('PROBE FAILED', e)
  child.kill()
  process.exit(1)
})
