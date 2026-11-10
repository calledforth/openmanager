import { createHash, randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isSea } from 'node:sea'
import {
  serveAgentToolsHttp,
  type AgentTool,
  type AgentToolContext,
  type AgentToolsHost,
  type RemoteAgentTools,
} from '@agentpack/runtime/node'

/** Where agents in another process reach the environment's own tools. */
export const MCP_PATH = '/mcp'
/** The bridge subcommand an agent without HTTP MCP launches (entry.ts). */
export const MCP_BRIDGE_COMMAND = 'mcp-bridge'
export const MCP_BRIDGE_URL_ENV = 'OPENMANAGER_MCP_URL'
export const MCP_BRIDGE_TOKEN_ENV = 'OPENMANAGER_MCP_TOKEN'

const digest = (token: string) => createHash('sha256').update(token).digest('hex')

/**
 * The environment's MCP server for agents outside its process (ACP).
 *
 * Each session runtime gets its own grant: a random 256-bit bearer token,
 * minted when the runtime starts and revoked when it ends, which names the
 * session every call acts for. The token is the whole boundary: the tunnel
 * reaches this server from loopback, so where a request comes from proves
 * nothing. Tokens are kept only as SHA-256 digests, so the lookup leaks
 * nothing about a token through timing. 256 bits cannot be guessed, so
 * failed attempts are not rate-limited.
 */
export function createAgentToolsEndpoint(deps: {
  serverName: string
  tools: readonly AgentTool[]
  /** The port this server listens on, known once it does. */
  port: () => number
  version: string
  log: (level: 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>) => void
}) {
  const grants = new Map<string, AgentToolContext>()

  /** How this process is launched again as the bridge: the executable itself, or Node and the entry script. */
  const bridgeLaunch = (): { command: string; args: string[] } => {
    if (isSea()) return { command: process.execPath, args: [MCP_BRIDGE_COMMAND] }
    const entry = process.argv[1]
    return {
      command: process.execPath,
      args: [...(entry ? [entry] : []), MCP_BRIDGE_COMMAND],
    }
  }

  const host: AgentToolsHost = {
    serverName: deps.serverName,
    tools: deps.tools,
    openRemote(context): RemoteAgentTools {
      const token = randomBytes(32).toString('base64url')
      const key = digest(token)
      grants.set(key, context)
      const url = `http://127.0.0.1:${deps.port()}${MCP_PATH}`
      const launch = bridgeLaunch()
      return {
        http: { url, headers: { Authorization: `Bearer ${token}` } },
        stdio: {
          command: launch.command,
          args: launch.args,
          env: { [MCP_BRIDGE_URL_ENV]: url, [MCP_BRIDGE_TOKEN_ENV]: token },
        },
        close: () => {
          grants.delete(key)
        },
      }
    },
  }

  const refuse = (response: ServerResponse, status: number, message: string) => {
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...(status === 401 ? { 'www-authenticate': 'Bearer' } : {}),
    })
    response.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message } }))
  }

  return {
    host,
    /** Live grants, for tests and diagnostics. */
    grantCount: () => grants.size,
    /** Answer `/mcp`; false for any other path. */
    handle(request: IncomingMessage, response: ServerResponse): boolean {
      const path = request.url?.split('?')[0]
      if (path !== MCP_PATH) return false
      const header = request.headers.authorization ?? ''
      const match = /^Bearer\s+(\S+)$/i.exec(header)
      const context = match ? grants.get(digest(match[1]!)) : undefined
      if (!context) {
        refuse(response, 401, 'This session has no access to the environment tools.')
        return true
      }
      serveAgentToolsHttp(request, response, host, context, deps.version).catch((error) => {
        deps.log('error', 'an agent tools request failed', { reason: String(error) })
        if (!response.headersSent) refuse(response, 500, 'The environment tools failed.')
        else response.end()
      })
      return true
    },
  }
}
