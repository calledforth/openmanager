import type { ChildProcess } from 'child_process'

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: unknown
}

interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

type JsonRpcInbound = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse
type RequestHandler = (method: string, params: unknown) => Promise<unknown>
type NotificationHandler = (method: string, params: unknown) => void

export class ACPConnection {
  private nextId = 1
  private stdoutBuffer = ''
  private pending = new Map<
    number,
    {
      resolve: (value: unknown) => void
      reject: (error: Error) => void
    }
  >()
  private requestHandler: RequestHandler | null = null
  private notificationHandlers = new Set<NotificationHandler>()
  private closed = false

  constructor(private process: ChildProcess) {
    this.process.stdout?.setEncoding('utf8')
    this.process.stdout?.on('data', (chunk: string) => this.onStdout(chunk))
    this.process.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trimEnd()
      if (text) console.error(`[acp:stderr] ${text}`)
    })
    this.process.on('exit', () => this.close(new Error('ACP process exited')))
    this.process.on('error', (error) => this.close(error))
  }

  onNotification(handler: NotificationHandler): () => void {
    this.notificationHandlers.add(handler)
    return () => this.notificationHandlers.delete(handler)
  }

  setRequestHandler(handler: RequestHandler): void {
    this.requestHandler = handler
  }

  async call<T>(method: string, params?: unknown): Promise<T> {
    if (this.closed) throw new Error('ACP connection closed')
    const id = this.nextId++
    const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) }
    this.write(req)
    return await new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
    })
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {}),
    }
    this.write(notification)
  }

  close(error?: Error): void {
    if (this.closed) return
    this.closed = true
    const failure = error ?? new Error('ACP connection closed')
    for (const [, pending] of this.pending) {
      pending.reject(failure)
    }
    this.pending.clear()
  }

  private write(message: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse): void {
    const line = JSON.stringify(message)
    this.process.stdin?.write(`${line}\n`)
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk
    const lines = this.stdoutBuffer.split('\n')
    this.stdoutBuffer = lines.pop() ?? ''
    for (const rawLine of lines) {
      const line = rawLine.trim()
      if (!line) continue
      let message: JsonRpcInbound
      try {
        message = JSON.parse(line) as JsonRpcInbound
      } catch {
        console.warn('[acp] failed to parse message:', line.slice(0, 200))
        continue
      }
      this.dispatch(message).catch((error) => {
        console.error('[acp] dispatch error:', error.message)
      })
    }
  }

  private async dispatch(message: JsonRpcInbound): Promise<void> {
    if ('id' in message && !('method' in message)) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) {
        const error = new Error(message.error.message)
        ;(error as Error & { code?: number; data?: unknown }).code = message.error.code
        ;(error as Error & { code?: number; data?: unknown }).data = message.error.data
        pending.reject(error)
      } else {
        pending.resolve(message.result)
      }
      return
    }

    if (!('method' in message)) return

    if ('id' in message) {
      if (!this.requestHandler) {
        const response: JsonRpcResponse = {
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: `Method not found: ${message.method}` },
        }
        this.write(response)
        return
      }
      try {
        const result = await this.requestHandler(message.method, message.params)
        const response: JsonRpcResponse = { jsonrpc: '2.0', id: message.id, result: result ?? null }
        this.write(response)
      } catch (error) {
        const response: JsonRpcResponse = {
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: -32000,
            message: error instanceof Error ? error.message : 'Request failed',
          },
        }
        this.write(response)
      }
      return
    }

    for (const handler of this.notificationHandlers) {
      handler(message.method, message.params)
    }
  }
}

