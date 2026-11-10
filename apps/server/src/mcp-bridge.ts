import { createInterface } from 'node:readline'
import { MCP_BRIDGE_TOKEN_ENV, MCP_BRIDGE_URL_ENV } from './pull-requests/mcp-endpoint.ts'

/**
 * `openmanager mcp-bridge`: the environment's tools over stdio, for an agent
 * that cannot reach an HTTP MCP server. The agent launches it with the
 * endpoint and its session's token in the environment
 * (`OPENMANAGER_MCP_URL`, `OPENMANAGER_MCP_TOKEN`); every newline-delimited
 * JSON-RPC message on stdin is POSTed there, and every answer comes back on
 * stdout, one per line. Nothing else is ever written to stdout.
 */
export async function runMcpBridge(
  env: NodeJS.ProcessEnv = process.env,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<number> {
  const url = env[MCP_BRIDGE_URL_ENV]
  const token = env[MCP_BRIDGE_TOKEN_ENV]
  if (!url || !token) {
    process.stderr.write(`mcp-bridge needs ${MCP_BRIDGE_URL_ENV} and ${MCP_BRIDGE_TOKEN_ENV}.\n`)
    return 2
  }
  const write = (message: unknown) => output.write(`${JSON.stringify(message)}\n`)
  const failed = (id: unknown, message: string) => {
    // Only a request (it has an id) is owed an answer.
    if (id !== undefined && id !== null) {
      write({ jsonrpc: '2.0', id, error: { code: -32603, message } })
    }
  }

  const forward = async (line: string) => {
    let message: { id?: unknown }
    try {
      message = JSON.parse(line) as { id?: unknown }
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
      return
    }
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: line,
      })
      if (response.status === 202) return
      const text = await response.text()
      if (!response.ok) {
        failed(message.id, `The environment answered ${response.status}: ${text.slice(0, 500)}`)
        return
      }
      const type = response.headers.get('content-type') ?? ''
      if (type.includes('text/event-stream')) {
        for (const data of text.split('\n').filter((part) => part.startsWith('data:'))) {
          const payload = data.slice(5).trim()
          if (payload) output.write(`${payload}\n`)
        }
        return
      }
      const body = JSON.parse(text) as unknown
      for (const item of Array.isArray(body) ? body : [body]) write(item)
    } catch (error) {
      failed(message.id, `The environment could not be reached: ${String(error)}`)
    }
  }

  const pending = new Set<Promise<void>>()
  const lines = createInterface({ input, crlfDelay: Infinity })
  for await (const line of lines) {
    if (!line.trim()) continue
    const sent = forward(line).finally(() => pending.delete(sent))
    pending.add(sent)
  }
  await Promise.all(pending)
  return 0
}
