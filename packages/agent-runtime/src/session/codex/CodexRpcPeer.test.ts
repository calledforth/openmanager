import {
  SERVER_NOTIFICATION_METHODS,
  SERVER_REQUEST_METHODS,
} from '@openmanager/codex-app-server-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CodexConnectionClosedError,
  CodexRpcError,
  CodexRpcPeer,
  CodexRpcTimeoutError,
  OTHER_KEY,
  RPC_INTERNAL_ERROR,
  RPC_METHOD_NOT_FOUND,
  type CodexRpcPeerOptions,
  type RpcId,
  STATS_KEY_LIMIT,
} from './CodexRpcPeer.js'

type Wire = Record<string, unknown>

/** A peer whose writes are parsed back into objects, and a `feed` that frames
 * what the server would send. */
function harness(options: Partial<CodexRpcPeerOptions> = {}) {
  const lines: string[] = []
  const log = vi.fn()
  const peer = new CodexRpcPeer({
    write: (line) => lines.push(line),
    log,
    defaultRequestTimeoutMs: 0,
    ...options,
  })
  const sent = (): Wire[] => lines.map((line) => JSON.parse(line) as Wire)
  const feed = (...messages: unknown[]): void =>
    peer.feed(messages.map((message) => `${JSON.stringify(message)}\n`).join(''))
  return { peer, lines, sent, feed, log }
}

/** Let handler promises and the peer's `finally` bookkeeping run. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

/** Outcome of a promise without awaiting it forever. */
function track<T>(promise: Promise<T>) {
  const state: { status: 'pending' | 'resolved' | 'rejected'; value?: T; error?: unknown } = {
    status: 'pending',
  }
  promise.then(
    (value) => Object.assign(state, { status: 'resolved', value }),
    (error: unknown) => Object.assign(state, { status: 'rejected', error }),
  )
  return state
}

const APPROVAL = 'item/commandExecution/requestApproval'
const KNOWN = 'turn/started'

describe('CodexRpcPeer framing', () => {
  it('writes one JSON object per line, without a jsonrpc member', () => {
    const { peer, lines, sent } = harness()
    void peer.request('model/list', {})
    void peer.request('account/logout')
    peer.notify('initialized')
    for (const line of lines) expect(line).not.toContain('\n')
    expect(sent()).toEqual([
      { id: 1, method: 'model/list', params: {} },
      // No params given means no params member, not `params: undefined`.
      { id: 2, method: 'account/logout' },
      { method: 'initialized' },
    ])
    for (const message of sent()) expect(message).not.toHaveProperty('jsonrpc')
  })

  it('discards an oversize notification, counts it, and keeps reading', async () => {
    const { peer, feed, sent, log } = harness({ maxLineChars: 64 })
    const listener = vi.fn()
    peer.onNotification(listener)
    const answered = peer.request('model/list', {})
    peer.feed(`${JSON.stringify({ method: KNOWN, params: { pad: 'x'.repeat(200) } })}\n`)
    feed({ id: 1, result: { data: [] } })
    await expect(answered).resolves.toEqual({ data: [] })
    expect(peer.stats.oversizeLines).toBe(1)
    expect(listener).not.toHaveBeenCalled()
    // A notification needs no answer: only the request went out.
    expect(sent()).toHaveLength(1)
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'warn',
        data: expect.objectContaining({ chars: expect.any(Number), method: KNOWN }),
      }),
    )
  })

  it('refuses an oversize server request at once with -32603, never running its handler', () => {
    // The server is blocked on this id; dropping the line silently would
    // leave it waiting forever.
    const { peer, sent } = harness({ maxLineChars: 64 })
    const handler = vi.fn()
    peer.handle(APPROVAL, handler)
    peer.feed(`${JSON.stringify({ id: 'big', method: APPROVAL, params: { pad: 'x'.repeat(200) } })}\n`)
    peer.feed(`${JSON.stringify({ id: 12, method: APPROVAL, params: { pad: 'x'.repeat(200) } })}\n`)
    expect(handler).not.toHaveBeenCalled()
    expect(sent()).toEqual([
      { id: 'big', error: { code: RPC_INTERNAL_ERROR, message: expect.stringMatching(/too large/) } },
      { id: 12, error: { code: RPC_INTERNAL_ERROR, message: expect.stringMatching(/too large/) } },
    ])
    expect(peer.stats.oversizeLines).toBe(2)
  })

  it('rejects the waiting request when its answer is oversize', async () => {
    const { peer, feed, sent } = harness({ maxLineChars: 64 })
    const first = peer.request('thread/read', {})
    const second = peer.request('model/list', {})
    peer.feed(`${JSON.stringify({ id: 1, result: { pad: 'x'.repeat(200) } })}\n`)
    // A string-echoed id is matched the same way as a number.
    peer.feed(`${JSON.stringify({ id: '2', result: { pad: 'x'.repeat(200) } })}\n`)
    for (const [answered, method] of [
      [first, 'thread/read'],
      [second, 'model/list'],
    ] as const) {
      const error = await answered.catch((e: unknown) => e)
      expect(error).toBeInstanceOf(CodexRpcError)
      expect(error).toMatchObject({ code: RPC_INTERNAL_ERROR, method, message: expect.stringMatching(/too large/) })
    }
    // Nothing is sent back for an oversize response, and a later answer to
    // the same id is late.
    expect(sent()).toHaveLength(2)
    feed({ id: 1, result: {} })
    expect(peer.stats.lateResponses).toBe(1)
  })

  it('only counts an oversize answer to an id nobody is waiting for', () => {
    const { peer, sent } = harness({ maxLineChars: 64 })
    peer.feed(`${JSON.stringify({ id: 42, result: { pad: 'x'.repeat(200) } })}\n`)
    expect(peer.stats.oversizeLines).toBe(1)
    expect(sent()).toEqual([])
  })

  // The biggest notifications are the likeliest to be oversize —
  // `item/completed` carrying a command's whole output — and their item has an
  // "id" of its own. Only the envelope's fields count, or the server gets an
  // error answer for an id it never asked about.
  it('sends nothing for an oversize notification whose params hold an "id"', () => {
    const { peer, sent } = harness({ maxLineChars: 64 })
    peer.feed(
      `${JSON.stringify({
        method: 'item/completed',
        params: { item: { type: 'commandExecution', id: 'call_abc', aggregatedOutput: 'x'.repeat(200) } },
      })}\n`,
    )
    expect(peer.stats.oversizeLines).toBe(1)
    expect(sent()).toEqual([])
  })

  // A "method" key inside a result must not turn a response into a server
  // request, or the request that was answered stays pending forever.
  it('rejects the waiting request when its oversize answer mentions "method"', async () => {
    const { peer, sent } = harness({ maxLineChars: 64 })
    const answered = track(peer.request('thread/read', {}))
    peer.feed(`${JSON.stringify({ id: 1, result: { calls: [{ method: 'tools/call' }], pad: 'x'.repeat(200) } })}\n`)
    await settle()
    expect(answered.status).toBe('rejected')
    expect(sent()).toHaveLength(1)
  })
})

describe('CodexRpcPeer response correlation', () => {
  it('resolves a request whose id is echoed as a number', async () => {
    const { peer, feed } = harness()
    const answered = peer.request('model/list', {})
    feed({ id: 1, result: { data: ['gpt'] } })
    await expect(answered).resolves.toEqual({ data: ['gpt'] })
  })

  it('resolves a request whose id is echoed as a string', async () => {
    // We send numbers, but nothing in the protocol promises they come back
    // as numbers.
    const { peer, feed } = harness()
    const first = peer.request('model/list', {})
    const second = peer.request('account/read', {})
    feed({ id: '2', result: 'second' }, { id: '1', result: 'first' })
    await expect(first).resolves.toBe('first')
    await expect(second).resolves.toBe('second')
  })

  it('resolves to null for a null result, and treats error: null as success', async () => {
    const { peer, feed } = harness()
    const a = peer.request('a')
    const b = peer.request('b')
    feed({ id: 1, result: null }, { id: 2, error: null, result: 7 })
    await expect(a).resolves.toBeNull()
    await expect(b).resolves.toBe(7)
  })

  it('rejects an error answer with CodexRpcError carrying code, message, data and method', async () => {
    const { peer, feed } = harness()
    const answered = peer.request('thread/start', {})
    feed({ id: 1, error: { code: -32000, message: 'no such model', data: { model: 'x' } } })
    const error = await answered.catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CodexRpcError)
    expect(error).toMatchObject({
      code: -32000,
      message: 'no such model',
      data: { model: 'x' },
      method: 'thread/start',
    })
  })

  it('fills in a code and message the error answer left out', async () => {
    const { peer, feed } = harness()
    const answered = peer.request('thread/start', {})
    feed({ id: 1, error: {} })
    await expect(answered).rejects.toMatchObject({
      code: RPC_INTERNAL_ERROR,
      message: expect.any(String),
    })
  })

  it('drops and counts an answer to an id nobody is waiting for', async () => {
    const { peer, feed } = harness()
    const answered = track(peer.request('model/list', {}))
    feed({ id: 99, result: {} }, { id: 'nope', error: { code: 1, message: 'x' } })
    await settle()
    expect(peer.stats.lateResponses).toBe(2)
    expect(answered.status).toBe('pending')
    // An answer is consumed once: a duplicate is late too.
    feed({ id: 1, result: 'ok' }, { id: 1, result: 'again' })
    await settle()
    expect(answered).toMatchObject({ status: 'resolved', value: 'ok' })
    expect(peer.stats.lateResponses).toBe(3)
  })
})

describe('CodexRpcPeer request timeouts', () => {
  afterEach(() => vi.useRealTimers())

  it('rejects with CodexRpcTimeoutError, then counts the late answer', async () => {
    vi.useFakeTimers()
    const { peer, feed } = harness({ defaultRequestTimeoutMs: 1_000 })
    const answered = track(peer.request('model/list', {}))
    await vi.advanceTimersByTimeAsync(999)
    expect(answered.status).toBe('pending')
    await vi.advanceTimersByTimeAsync(1)
    expect(answered.status).toBe('rejected')
    expect(answered.error).toBeInstanceOf(CodexRpcTimeoutError)
    expect(answered.error).toMatchObject({ method: 'model/list', timeoutMs: 1_000 })

    feed({ id: 1, result: {} })
    expect(peer.stats.lateResponses).toBe(1)
  })

  it('lets a per-request timeout override the default, and 0 mean none', async () => {
    vi.useFakeTimers()
    const { peer } = harness({ defaultRequestTimeoutMs: 1_000 })
    const quick = track(peer.request('a', undefined, { timeoutMs: 10 }))
    const forever = track(peer.request('turn/start', {}, { timeoutMs: 0 }))
    await vi.advanceTimersByTimeAsync(10)
    expect(quick.status).toBe('rejected')
    await vi.advanceTimersByTimeAsync(60 * 60 * 1_000)
    expect(forever.status).toBe('pending')
  })

  it('rejects with the abort reason and forgets the request', async () => {
    const { peer, feed } = harness()
    const controller = new AbortController()
    const answered = peer.request('model/list', {}, { signal: controller.signal })
    const reason = new Error('user cancelled')
    controller.abort(reason)
    await expect(answered).rejects.toBe(reason)
    feed({ id: 1, result: {} })
    expect(peer.stats.lateResponses).toBe(1)
  })

  it('arms no timer and sends nothing for a signal that is already aborted', async () => {
    vi.useFakeTimers()
    const { peer, sent } = harness({ defaultRequestTimeoutMs: 60_000 })
    const controller = new AbortController()
    controller.abort(new Error('gone'))
    await expect(peer.request('model/list', {}, { signal: controller.signal })).rejects.toThrow('gone')
    expect(vi.getTimerCount()).toBe(0)
    expect(sent()).toEqual([])
  })

  it('rejects a request whose params cannot be serialised, sending nothing', async () => {
    // Nothing went out, so nothing will answer: waiting out a timeout (or
    // forever, with none) would be wrong.
    const { peer, sent } = harness()
    const answered = track(peer.request('model/list', { limit: 1n }))
    await settle()
    expect(answered.status).toBe('rejected')
    expect(answered.error).toBeInstanceOf(TypeError)
    expect(sent()).toEqual([])
  })
})

describe('CodexRpcPeer server requests', () => {
  it('runs at most the cap at once, starts the rest in arrival order, and answers each by its id', async () => {
    const { peer, feed, sent } = harness({ maxConcurrentServerRequests: 2 })
    const started: RpcId[] = []
    const finish = new Map<RpcId, (result: unknown) => void>()
    let running = 0
    let peak = 0
    peer.handle(APPROVAL, (_params, { id }) => {
      started.push(id)
      running++
      peak = Math.max(peak, running)
      return new Promise((resolve) =>
        finish.set(id, (result) => {
          running--
          resolve(result)
        }),
      )
    })

    // Mixed id kinds: a string id must come back as a string, not "1" → 1.
    const ids: RpcId[] = [1, 'two', 3, 'four', 5]
    feed(...ids.map((id) => ({ id, method: APPROVAL, params: { n: id } })))
    expect(started).toEqual([1, 'two'])

    // The second finishes first: its slot goes to the next in line.
    finish.get('two')!({ decision: 'two' })
    await settle()
    expect(started).toEqual([1, 'two', 3])
    finish.get(1)!({ decision: 1 })
    await settle()
    expect(started).toEqual([1, 'two', 3, 'four'])
    finish.get(3)!({ decision: 3 })
    finish.get('four')!({ decision: 'four' })
    await settle()
    expect(started).toEqual(ids)
    finish.get(5)!({ decision: 5 })
    await settle()

    expect(peak).toBe(2)
    expect(sent()).toEqual([
      { id: 'two', result: { decision: 'two' } },
      { id: 1, result: { decision: 1 } },
      { id: 3, result: { decision: 3 } },
      { id: 'four', result: { decision: 'four' } },
      { id: 5, result: { decision: 5 } },
    ])
  })

  it('passes params and the id to the handler, and answers null for no result', async () => {
    const { peer, feed, sent } = harness()
    const handler = vi.fn(() => undefined)
    peer.handle(APPROVAL, handler)
    feed({ id: 'r-1', method: APPROVAL, params: { command: 'ls' } })
    await settle()
    expect(handler).toHaveBeenCalledWith({ command: 'ls' }, expect.objectContaining({ id: 'r-1' }))
    expect(sent()).toEqual([{ id: 'r-1', result: null }])
  })

  it('refuses a request nobody handles at once with -32601, even while the cap is full', async () => {
    // Approvals park for as long as a person takes. A request nobody can
    // answer must not queue behind them.
    const { peer, feed, sent, log } = harness({ maxConcurrentServerRequests: 1 })
    peer.handle(APPROVAL, () => new Promise(() => undefined))
    feed(
      { id: 1, method: APPROVAL, params: {} },
      { id: 2, method: APPROVAL, params: {} },
      { id: 'q', method: 'item/tool/requestUserInput', params: {} },
      { id: 4, method: 'made/up/request', params: {} },
    )
    expect(sent()).toEqual([
      { id: 'q', error: { code: RPC_METHOD_NOT_FOUND, message: expect.any(String) } },
      { id: 4, error: { code: RPC_METHOD_NOT_FOUND, message: expect.any(String) } },
    ])
    expect(peer.stats.unhandledServerRequests).toEqual(
      new Map([
        ['item/tool/requestUserInput', 1],
        ['made/up/request', 1],
      ]),
    )
    // A known method nobody handles is expected; an unknown one is news.
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'info', data: { method: 'item/tool/requestUserInput' } }),
    )
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'warn', data: { method: 'made/up/request' } }),
    )
  })

  it('answers a thrown CodexRpcError with its own code, message and data', async () => {
    const { peer, feed, sent } = harness()
    peer.handle(APPROVAL, async () => {
      throw new CodexRpcError(-32001, 'declined', { why: 'policy' })
    })
    feed({ id: 7, method: APPROVAL, params: {} })
    await settle()
    expect(sent()).toEqual([{ id: 7, error: { code: -32001, message: 'declined', data: { why: 'policy' } } }])
  })

  it('answers -32603 for anything else thrown, sync or async, and logs it', async () => {
    const { peer, feed, sent, log } = harness()
    peer.handle(APPROVAL, () => {
      throw new Error('handler bug')
    })
    peer.handle('item/fileChange/requestApproval', async () => {
      throw 'not even an Error'
    })
    feed(
      { id: 1, method: APPROVAL, params: {} },
      { id: 2, method: 'item/fileChange/requestApproval', params: {} },
    )
    await settle()
    expect(sent()).toEqual([
      { id: 1, error: { code: RPC_INTERNAL_ERROR, message: expect.any(String) } },
      { id: 2, error: { code: RPC_INTERNAL_ERROR, message: expect.any(String) } },
    ])
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'error', data: expect.objectContaining({ error: 'Error: handler bug' }) }),
    )
  })

  it('frees the slot of a handler that failed', async () => {
    const { peer, feed, sent } = harness({ maxConcurrentServerRequests: 1 })
    let calls = 0
    peer.handle(APPROVAL, () => {
      if (++calls === 1) throw new Error('first fails')
      return 'second ok'
    })
    feed({ id: 1, method: APPROVAL, params: {} }, { id: 2, method: APPROVAL, params: {} })
    await settle()
    expect(sent()).toEqual([
      { id: 1, error: { code: RPC_INTERNAL_ERROR, message: expect.any(String) } },
      { id: 2, result: 'second ok' },
    ])
  })

  it('stops routing to a handler once unregistered, and keeps a replacement', () => {
    const { peer, feed, sent } = harness()
    const first = vi.fn()
    const unregisterFirst = peer.handle(APPROVAL, first)
    const second = vi.fn(() => 'second')
    const unregisterSecond = peer.handle(APPROVAL, second)
    // The stale unregister must not remove the handler that replaced it.
    unregisterFirst()
    feed({ id: 1, method: APPROVAL, params: {} })
    expect(second).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()
    unregisterSecond()
    feed({ id: 2, method: APPROVAL, params: {} })
    expect(sent()).toContainEqual({ id: 2, error: { code: RPC_METHOD_NOT_FOUND, message: expect.any(String) } })
  })

  it('answers -32603 when the handler result cannot be serialised', async () => {
    // An answer the server cannot use still beats leaving it waiting.
    const { peer, feed, sent } = harness()
    peer.handle(APPROVAL, () => ({ big: 1n }))
    feed({ id: 1, method: APPROVAL, params: {} })
    await settle()
    expect(sent()).toEqual([{ id: 1, error: { code: RPC_INTERNAL_ERROR, message: expect.any(String) } }])
  })
})

describe('CodexRpcPeer notifications', () => {
  it('only knows methods from the vendored list', () => {
    // Guards the fixtures below against a regeneration renaming them.
    expect(SERVER_NOTIFICATION_METHODS).toContain(KNOWN)
    expect(SERVER_NOTIFICATION_METHODS).toContain('item/agentMessage/delta')
    expect(SERVER_REQUEST_METHODS).toContain(APPROVAL)
  })

  it('delivers in arrival order, interleaved with server requests', () => {
    const { peer, feed } = harness()
    const seen: string[] = []
    peer.onNotification(({ method, params }) => seen.push(`${method}:${(params as { n: number }).n}`))
    peer.handle(APPROVAL, (params) => {
      seen.push(`request:${(params as { n: number }).n}`)
      return new Promise(() => undefined)
    })
    // One chunk, as a burst off the pipe would arrive.
    feed(
      { method: KNOWN, params: { n: 1 } },
      { method: 'item/agentMessage/delta', params: { n: 2 } },
      { id: 'a', method: APPROVAL, params: { n: 3 } },
      { method: 'item/agentMessage/delta', params: { n: 4 } },
      { id: 'b', method: APPROVAL, params: { n: 5 } },
      { method: 'turn/completed', params: { n: 6 } },
    )
    expect(seen).toEqual([
      'turn/started:1',
      'item/agentMessage/delta:2',
      'request:3',
      'item/agentMessage/delta:4',
      'request:5',
      'turn/completed:6',
    ])
  })

  it('keeps delivering to other listeners and later notifications when one throws', () => {
    const { peer, feed, log } = harness()
    const before = vi.fn()
    const after = vi.fn()
    peer.onNotification(before)
    peer.onNotification(() => {
      throw new Error('consumer bug')
    })
    peer.onNotification(after)
    feed({ method: KNOWN, params: { n: 1 } }, { method: KNOWN, params: { n: 2 } })
    expect(before.mock.calls.map(([m]) => m.params)).toEqual([{ n: 1 }, { n: 2 }])
    expect(after.mock.calls.map(([m]) => m.params)).toEqual([{ n: 1 }, { n: 2 }])
    expect(log).toHaveBeenCalledTimes(2)
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'error', data: { method: KNOWN, error: 'Error: consumer bug' } }),
    )
  })

  it('stops delivering to a listener once unsubscribed', () => {
    const { peer, feed } = harness()
    const listener = vi.fn()
    const off = peer.onNotification(listener)
    feed({ method: KNOWN, params: {} })
    off()
    feed({ method: KNOWN, params: {} })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('drops and counts a notification the vendored list does not know, logging it once', () => {
    const { peer, feed, log } = harness()
    const listener = vi.fn()
    peer.onNotification(listener)
    feed(
      { method: 'made/up/notification', params: {} },
      { method: 'made/up/notification', params: {} },
      { method: 'other/unknown' },
      { method: KNOWN, params: {} },
    )
    expect(listener.mock.calls.map(([m]) => m.method)).toEqual([KNOWN])
    expect(peer.stats.unknownNotifications).toEqual(
      new Map([
        ['made/up/notification', 2],
        ['other/unknown', 1],
      ]),
    )
    expect(log).toHaveBeenCalledTimes(2)
  })
})

describe('CodexRpcPeer decode tolerance', () => {
  it('counts and logs lines that are no JSON-RPC message, and keeps working', async () => {
    const { peer, feed, log } = harness()
    const answered = peer.request('model/list', {})
    const listener = vi.fn()
    peer.onNotification(listener)
    const junk = [
      'not json at all',
      '{"truncated":',
      '[{"id":1,"result":{}}]',
      '42',
      '"a string"',
      'null',
      'true',
      '{"foo":"bar"}',
      // An id with neither result nor error is not an answer.
      '{"id":1}',
      // An id that is no legal id.
      '{"id":{"x":1},"result":{}}',
    ]
    peer.feed(junk.map((line) => `${line}\n`).join(''))
    expect(peer.stats.decodeErrors).toBe(junk.length)
    expect(log).toHaveBeenCalledTimes(junk.length)
    for (const [entry] of log.mock.calls) expect(entry).toMatchObject({ scope: 'codex', level: 'warn' })

    feed({ method: KNOWN, params: {} }, { id: 1, result: { data: [] } })
    expect(listener).toHaveBeenCalledTimes(1)
    await expect(answered).resolves.toEqual({ data: [] })
    expect(peer.closed).toBe(false)
  })

  it('truncates a long bad line in the log', () => {
    const { peer, log } = harness()
    peer.feed(`${'z'.repeat(5_000)}\n`)
    const logged = (log.mock.calls[0]![0] as { data: { line: string } }).data.line
    expect(logged.length).toBeLessThan(600)
  })

  it('delivers a final unterminated line at end of input', async () => {
    const { peer } = harness()
    const answered = peer.request('model/list', {})
    peer.feed('{"id":1,"result":"last"}')
    peer.endOfInput()
    await expect(answered).resolves.toBe('last')
  })
})

describe('CodexRpcPeer close', () => {
  it('rejects pending requests, aborts running handlers and drops queued ones', async () => {
    const { peer, feed, sent } = harness({ maxConcurrentServerRequests: 1 })
    const signals: AbortSignal[] = []
    const handler = vi.fn((_params: unknown, { signal }: { signal: AbortSignal }) => {
      signals.push(signal)
      return new Promise((resolve) => signal.addEventListener('abort', () => resolve('too late')))
    })
    peer.handle(APPROVAL, handler)
    feed({ id: 1, method: APPROVAL, params: {} }, { id: 2, method: APPROVAL, params: {} })
    const answered = peer.request('model/list', {})
    const sentBefore = sent().length

    const reason = new CodexConnectionClosedError('gone')
    peer.close(reason)
    peer.close(new Error('second reason loses'))

    await expect(answered).rejects.toBe(reason)
    expect(signals[0]!.aborted).toBe(true)
    await settle()
    // The queued request never ran; the running one's late result was not sent.
    expect(handler).toHaveBeenCalledTimes(1)
    expect(sent()).toHaveLength(sentBefore)
    expect(peer.closed).toBe(true)
  })

  it('rejects new requests at once and ignores input after close', async () => {
    const { peer, sent } = harness()
    const reason = new Error('closed')
    peer.close(reason)
    await expect(peer.request('model/list', {})).rejects.toBe(reason)
    peer.notify('initialized')
    peer.feed('not json\n')
    expect(sent()).toEqual([])
    expect(peer.stats.decodeErrors).toBe(0)
  })

  it('logs and survives a write that throws', () => {
    const log = vi.fn()
    const peer = new CodexRpcPeer({
      write: () => {
        throw new Error('EPIPE')
      },
      log,
      defaultRequestTimeoutMs: 0,
    })
    expect(() => peer.notify('initialized')).not.toThrow()
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ level: 'warn' }))
  })
})

describe('CodexRpcPeer stats', () => {
  it('records unknown items for the layer above', () => {
    const { peer } = harness()
    peer.countUnknownItem('hologram')
    peer.countUnknownItem('hologram')
    expect(peer.stats.unknownItems).toEqual(new Map([['hologram', 2]]))
  })

  it('caps distinct keys, folding the rest into OTHER_KEY', () => {
    // Method names come off the wire: a misbehaving server must not be able
    // to grow the maps for as long as the connection lives.
    const { peer, feed, sent } = harness()
    const extra = 50
    for (let i = 0; i < STATS_KEY_LIMIT + extra; i++) feed({ method: `made/up/${i}` })
    // A key that made it in before the cap keeps its own count afterwards.
    feed({ method: 'made/up/0' })
    const unknown = peer.stats.unknownNotifications
    expect(unknown.size).toBe(STATS_KEY_LIMIT + 1)
    expect(unknown.get(OTHER_KEY)).toBe(extra)
    expect(unknown.get('made/up/0')).toBe(2)
    expect(unknown.has(`made/up/${STATS_KEY_LIMIT}`)).toBe(false)

    for (let i = 0; i < STATS_KEY_LIMIT + 5; i++) feed({ id: i, method: `no/handler/${i}` })
    expect(peer.stats.unhandledServerRequests.size).toBe(STATS_KEY_LIMIT + 1)
    expect(peer.stats.unhandledServerRequests.get(OTHER_KEY)).toBe(5)
    // Folded or not, every one of them was still answered.
    expect(sent()).toHaveLength(STATS_KEY_LIMIT + 5)

    for (let i = 0; i < STATS_KEY_LIMIT + 3; i++) peer.countUnknownItem(`type-${i}`)
    expect(peer.stats.unknownItems.get(OTHER_KEY)).toBe(3)
  })
})

describe('CodexRpcPeer immediate handlers', () => {
  it('answers an immediate handler at once while the cap is saturated', async () => {
    const { peer, feed, sent } = harness({ maxConcurrentServerRequests: 1 })
    const parked = vi.fn(() => new Promise(() => undefined))
    peer.handle(APPROVAL, parked)
    peer.handle('currentTime/read', () => ({ currentTimeAt: 1 }), { immediate: true })
    feed(
      { id: 1, method: APPROVAL, params: {} },
      { id: 2, method: APPROVAL, params: {} },
      { id: 'now', method: 'currentTime/read', params: {} },
    )
    await settle()
    expect(parked).toHaveBeenCalledTimes(1)
    expect(sent()).toEqual([{ id: 'now', result: { currentTimeAt: 1 } }])
  })

  it('does not let immediate handlers use up the cap', async () => {
    const { peer, feed, sent } = harness({ maxConcurrentServerRequests: 1 })
    let release: (() => void) | undefined
    peer.handle('currentTime/read', () => new Promise<void>((resolve) => (release = resolve)), {
      immediate: true,
    })
    peer.handle(APPROVAL, () => 'approved')
    feed({ id: 'slow', method: 'currentTime/read' }, { id: 1, method: APPROVAL, params: {} })
    await settle()
    expect(sent()).toEqual([{ id: 1, result: 'approved' }])
    release?.()
    await settle()
    expect(sent()).toContainEqual({ id: 'slow', result: null })
  })
})

describe('CodexRpcPeer cancelServerRequest', () => {
  it('drops a queued request before its handler runs', async () => {
    const { peer, feed, sent } = harness({ maxConcurrentServerRequests: 1 })
    const started: RpcId[] = []
    let finishFirst: ((value: unknown) => void) | undefined
    peer.handle(APPROVAL, (_params, { id }) => {
      started.push(id)
      if (id === 1) return new Promise((resolve) => (finishFirst = resolve))
      return `answer ${String(id)}`
    })
    feed(
      { id: 1, method: APPROVAL, params: {} },
      { id: 'two', method: APPROVAL, params: {} },
      { id: 3, method: APPROVAL, params: {} },
    )
    expect(peer.cancelServerRequest('two')).toBe(true)
    finishFirst?.('answer 1')
    await settle()
    expect(started).toEqual([1, 3])
    expect(sent()).toEqual([
      { id: 1, result: 'answer 1' },
      { id: 3, result: 'answer 3' },
    ])
    // Gone now: a second cancel knows nothing of it.
    expect(peer.cancelServerRequest('two')).toBe(false)
  })

  it('aborts a running handler, sends nothing for it, and frees its slot', async () => {
    const { peer, feed, sent } = harness({ maxConcurrentServerRequests: 1 })
    const signals = new Map<RpcId, AbortSignal>()
    peer.handle(APPROVAL, (_params, { id, signal }) => {
      signals.set(id, signal)
      if (id !== 1) return 'next'
      // An approval card that settles once it is told nobody needs it.
      return new Promise((resolve) => signal.addEventListener('abort', () => resolve('stale')))
    })
    feed({ id: 1, method: APPROVAL, params: {} }, { id: 2, method: APPROVAL, params: {} })
    expect(signals.has(2)).toBe(false)

    expect(peer.cancelServerRequest(1)).toBe(true)
    expect(signals.get(1)!.aborted).toBe(true)
    expect(signals.get(1)!.reason).toBeInstanceOf(CodexConnectionClosedError)
    await settle()
    expect(sent()).toEqual([{ id: 2, result: 'next' }])
    // Only the cancelled request's signal fired.
    expect(signals.get(2)!.aborted).toBe(false)
    expect(peer.closed).toBe(false)
  })

  it('discards the error of a cancelled handler too', async () => {
    const { peer, feed, sent } = harness()
    peer.handle(APPROVAL, (_params, { signal }) => {
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))))
    })
    feed({ id: 1, method: APPROVAL, params: {} })
    peer.cancelServerRequest(1)
    await settle()
    expect(sent()).toEqual([])
  })

  it('returns false for an id it does not know, or one already answered', async () => {
    const { peer, feed } = harness()
    peer.handle(APPROVAL, () => 'done')
    expect(peer.cancelServerRequest(404)).toBe(false)
    feed({ id: 1, method: APPROVAL, params: {} })
    await settle()
    expect(peer.cancelServerRequest(1)).toBe(false)
  })

  it('gives each request its own signal, released once it settles', async () => {
    // One shared signal would collect a listener per approval for the whole
    // life of the connection.
    const { peer, feed, sent } = harness({ maxConcurrentServerRequests: 4 })
    const signals: AbortSignal[] = []
    peer.handle(APPROVAL, async (_params, { signal }) => {
      signals.push(signal)
      signal.addEventListener('abort', () => undefined)
      return 'ok'
    })
    for (let i = 0; i < 30; i++) feed({ id: i, method: APPROVAL, params: {} })
    await settle()
    expect(sent()).toHaveLength(30)
    expect(new Set(signals).size).toBe(30)

    let parkedSignal: AbortSignal | undefined
    peer.handle(APPROVAL, (_params, { signal }) => {
      parkedSignal = signal
      return new Promise(() => undefined)
    })
    feed({ id: 'parked', method: APPROVAL, params: {} })
    peer.close(new Error('bye'))
    // Close aborts what is running, and only that: the settled ones were let go.
    expect(parkedSignal!.aborted).toBe(true)
    expect(signals.some((signal) => signal.aborted)).toBe(false)
  })
})

describe('CodexRpcPeer close mid-chunk', () => {
  it('delivers nothing after a listener closes the peer part-way through a chunk', async () => {
    const { peer, sent } = harness()
    const seen: unknown[] = []
    const handler = vi.fn(() => 'answer')
    peer.handle(APPROVAL, handler)
    peer.onNotification((message) => {
      seen.push(message.params)
      peer.close(new Error('consumer closed'))
    })
    peer.feed(
      [
        { method: KNOWN, params: { n: 1 } },
        { method: KNOWN, params: { n: 2 } },
        { id: 3, method: APPROVAL, params: {} },
      ]
        .map((message) => `${JSON.stringify(message)}\n`)
        .join(''),
    )
    await settle()
    expect(seen).toEqual([{ n: 1 }])
    expect(handler).not.toHaveBeenCalled()
    expect(sent()).toEqual([])
    expect(peer.stats.decodeErrors).toBe(0)
  })
})
