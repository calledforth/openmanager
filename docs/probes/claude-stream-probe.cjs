/* Probe Claude Code stream-json for thinking deltas + timing. */
const { spawn } = require('node:child_process')
const fs = require('node:fs')

const PROMPT =
  process.env.PROBE_PROMPT ||
  'Read packages/agent-view/src/fold/foldEvents.ts and packages/agent-runtime/src/backends/acp/AcpBackend.ts, then grep for "agent_thought_chunk". Explain in 2 sentences how thinking chunks fold into rows. Do not edit files.'
const CWD = 'C:\\Users\\rajku\\OneDrive\\Documents\\ClePro\\openmanager'
const OUT = process.env.PROBE_OUT || 'claude-raw.jsonl'

const args = [
  '-p',
  PROMPT,
  '--output-format',
  'stream-json',
  '--verbose',
  '--include-partial-messages',
  '--permission-mode',
  'plan',
  ...(process.env.PROBE_MODEL ? ['--model', process.env.PROBE_MODEL] : []),
]
const child = spawn('claude', args, { cwd: CWD, shell: true })
const t0 = Date.now()
const raw = fs.createWriteStream(OUT)
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
  runs.push({ kind: label, n: 0, start: Date.now() - t0, end: Date.now() - t0, text: '' })
}

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
    if (m.type === 'stream_event') {
      const e = m.event
      if (e?.type === 'content_block_delta') {
        const d2 = e.delta
        if (d2.type === 'thinking_delta') note('THINKING', d2.thinking ?? '')
        else if (d2.type === 'text_delta') note('TEXT', d2.text ?? '')
        else if (d2.type === 'input_json_delta') note('TOOL_INPUT', '')
        else if (d2.type === 'signature_delta') note('SIGNATURE', '')
      } else if (e?.type === 'content_block_start') {
        const b = e.content_block
        breakRun(`  block_start:${b?.type}${b?.name ? ' ' + b.name : ''}`)
      }
    } else if (m.type === 'user') {
      breakRun('  tool_result')
    } else if (m.type === 'result') {
      breakRun(`  RESULT ${m.subtype}`)
    }
  }
})
child.stderr.on('data', (d) => process.stderr.write('[err] ' + d))
child.on('close', (code) => {
  console.log('exit', code)
  for (const r of runs) {
    if (r.n === 0) {
      console.log(`[${String(r.start).padStart(6)}ms] ${r.kind}`)
      continue
    }
    const span = r.end - r.start
    const rate = span > 0 ? `${((r.text.length / (span / 1000)) | 0)} ch/s` : 'INSTANT'
    console.log(
      `[${String(r.start).padStart(6)}ms] ${r.kind.padEnd(10)} chunks=${String(r.n).padStart(4)} span=${String(span).padStart(5)}ms chars=${String(r.text.length).padStart(5)} ${rate}`,
    )
    if (r.kind === 'THINKING') console.log('        ' + JSON.stringify(r.text.slice(0, 300)))
  }
})
