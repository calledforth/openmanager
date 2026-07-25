/* Probe `codex app-server` for reasoning deltas + timing.
   NDJSON, JSON-RPC-shaped envelopes WITHOUT the "jsonrpc" member. */
const { spawn } = require('node:child_process')
const fs = require('node:fs')

const CWD = 'C:\\Users\\rajku\\OneDrive\\Documents\\ClePro\\openmanager'
const PROMPT =
  process.env.PROBE_PROMPT ||
  'Read packages/agent-view/src/fold/foldEvents.ts and packages/agent-runtime/src/backends/acp/AcpBackend.ts, then grep for "agent_thought_chunk". Explain in 2 sentences how thinking chunks fold into rows. Do not edit files.'
const OUT = process.env.PROBE_OUT || 'codex-raw2.jsonl'

const child = spawn('codex', ['-c','model_reasoning_summary="detailed"','-c','show_raw_agent_reasoning=true','app-server'], { cwd: CWD, shell: true })
const t0 = Date.now()
const raw = fs.createWriteStream(OUT)

let nextId = 1
const pending = new Map()
function send(method, params) {
  const id = nextId++
  child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
  return new Promise((res, rej) => pending.set(id, { res, rej }))
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ method, params }) + '\n')
}
function respond(id, result) {
  child.stdin.write(JSON.stringify({ id, result }) + '\n')
}

const runs = []
let cur = null
function note(kind, text) {
  if (cur && cur.kind === kind) {
    cur.n++
    cur.end = Date.now() - t0
    cur.text += text
  } else {
    cur = { kind, n: 1, start: Date.now() - t0, end: Date.now() - t0, text }
    runs.push(cur)
  }
}
function breakRun(label) {
  cur = null
  if (label) runs.push({ kind: label, n: 0, start: Date.now() - t0, end: Date.now() - t0, text: '' })
}

let done
const finished = new Promise((r) => (done = r))
let buf = ''
child.stdout.on('data', (d) => {
  buf += d.toString()
  const lines = buf.split('\n')
  buf = lines.pop() || ''
  for (const l of lines) {
    if (!l.trim()) continue
    raw.write(Date.now() - t0 + ' ' + l + '\n')
    let m
    try {
      m = JSON.parse(l)
    } catch {
      continue
    }
    if (m.id !== undefined && (m.result !== undefined || m.error !== undefined)) {
      const p = pending.get(m.id)
      pending.delete(m.id)
      if (p) (m.error ? p.rej : p.res)(m.error ?? m.result)
      continue
    }
    if (m.id !== undefined && m.method) {
      // server -> client request (approvals)
      breakRun(`  REQ ${m.method}`)
      const d2 = /fileChange|commandExecution/.test(m.method) ? { decision: 'accept' } : {}
      respond(m.id, d2)
      continue
    }
    const meth = m.method
    if (meth === 'item/reasoning/textDelta') note('REASONING', m.params?.delta ?? '')
    else if (meth === 'item/reasoning/summaryTextDelta')
      note('REASON_SUM', m.params?.delta ?? '')
    else if (meth === 'item/agentMessage/delta') note('TEXT', m.params?.delta ?? '')
    else if (meth === 'item/started')
      breakRun(`  item/started ${m.params?.item?.type ?? m.params?.item?.item_type ?? '?'}`)
    else if (meth === 'item/completed')
      breakRun(`  item/completed ${m.params?.item?.type ?? m.params?.item?.item_type ?? '?'}`)
    else if (meth === 'turn/completed') {
      breakRun('  TURN COMPLETED')
      done()
    } else if (meth === 'error') breakRun(`  ERROR ${JSON.stringify(m.params).slice(0, 200)}`)
  }
})
child.stderr.on('data', (d) => process.stderr.write('[err] ' + d))
;(async () => {
  const init = await send('initialize', {
    clientInfo: { name: 'probe', version: '1.0.0' },
    capabilities: { experimentalApi: true },
  })
  console.error('userAgent:', JSON.stringify(init.userAgent ?? init).slice(0, 200))
  notify('initialized', {})
  const th = await send('thread/start', {
    cwd: CWD,
    approvalPolicy: 'untrusted',
    sandbox: 'read-only',
  })
  const threadId = th.threadId ?? th.thread?.id ?? th.id
  console.error('threadId:', threadId)
  await send('turn/start', {
    threadId,
    input: [{ type: 'text', text: PROMPT }],
  })
  await Promise.race([finished, new Promise((r) => setTimeout(r, 180000))])

  for (const r of runs) {
    if (r.n === 0) {
      console.log(`[${String(r.start).padStart(6)}ms] ${r.kind}`)
      continue
    }
    const span = r.end - r.start
    const rate = span > 0 ? `${((r.text.length / (span / 1000)) | 0)} ch/s` : 'INSTANT'
    console.log(
      `[${String(r.start).padStart(6)}ms] ${r.kind.padEnd(11)} chunks=${String(r.n).padStart(4)} span=${String(span).padStart(5)}ms chars=${String(r.text.length).padStart(5)} ${rate}`,
    )
    if (r.kind.startsWith('REASON'))
      console.log('        ' + JSON.stringify(r.text.slice(0, 300)))
  }
  child.kill()
  process.exit(0)
})().catch((e) => {
  console.error('CODEX PROBE FAILED', e)
  child.kill()
  process.exit(1)
})
