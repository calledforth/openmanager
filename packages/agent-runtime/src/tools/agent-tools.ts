import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ProviderId } from '@agentpack/contract'
import type { z } from 'zod'

/**
 * Tools the host serves to every agent session it runs, as one MCP server.
 *
 * The host writes each tool once; the runtime carries it to the agent the way
 * that agent can take it: an in-process SDK server for Claude Code, and an
 * MCP endpoint the host serves for an agent in another process (ACP), reached
 * over HTTP or, for an agent without HTTP MCP, through a stdio bridge.
 */

/** Who is calling: the runtime thread the agent belongs to, read at call time. */
export interface AgentToolContext {
  /** Current, not captured: a `create_session` rebind renames the thread. */
  readonly threadId: string
  readonly providerId: ProviderId
}

/** What a tool answers the agent. `isError` is an MCP tool error the agent reads. */
export type AgentToolResult = { text: string; isError?: boolean }

export interface AgentTool {
  name: string
  description: string
  /** A zod raw shape (zod 4); both MCP transports validate against it. */
  inputSchema: Record<string, z.ZodType>
  call(input: Record<string, unknown>, context: AgentToolContext): Promise<AgentToolResult>
}

/** How an agent in another process reaches the host's tools for one session. */
export interface RemoteAgentTools {
  /** A Streamable HTTP MCP endpoint and the headers that authorize this session. */
  http: { url: string; headers: Record<string, string> }
  /** The same endpoint behind a stdio bridge, for an agent without HTTP MCP. */
  stdio: { command: string; args: string[]; env: Record<string, string> }
  /** Revoke the grant: called once, when the session runtime ends. */
  close(): void
}

export interface AgentToolsHost {
  /** The MCP server name; Claude Code lists its tools as `mcp__<name>__<tool>`. */
  serverName: string
  tools: readonly AgentTool[]
  /**
   * A grant bound to one session, for an agent that runs out of process.
   * Absent when the host serves no endpoint: such agents get no tools.
   */
  openRemote?(context: AgentToolContext): RemoteAgentTools
}

/** The name Claude Code gives one of the host's tools. */
export const claudeToolName = (serverName: string, toolName: string) =>
  `mcp__${serverName}__${toolName}`

const textResult = (result: AgentToolResult) => ({
  content: [{ type: 'text' as const, text: result.text }],
  ...(result.isError ? { isError: true } : {}),
})

/** A tool that throws answers the agent with an error rather than failing the call. */
export async function callAgentTool(
  tool: AgentTool,
  input: Record<string, unknown>,
  context: AgentToolContext,
): Promise<AgentToolResult> {
  try {
    return await tool.call(input, context)
  } catch (error) {
    return {
      text: `${tool.name} failed: ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
    }
  }
}

/**
 * Answer one request to the host's MCP endpoint for an already authorized
 * session. Stateless Streamable HTTP with JSON answers: every POST is
 * complete in itself, so nothing is held between requests and a grant is
 * the whole of a session's state. The MCP SDK is loaded on first use, like
 * the Claude SDK, so a host that never serves it never loads it.
 */
export async function serveAgentToolsHttp(
  request: IncomingMessage,
  response: ServerResponse,
  host: Pick<AgentToolsHost, 'serverName' | 'tools'>,
  context: AgentToolContext,
  version = '0.1.0',
): Promise<void> {
  const [{ McpServer }, { StreamableHTTPServerTransport }] = await Promise.all([
    import('@modelcontextprotocol/sdk/server/mcp.js'),
    import('@modelcontextprotocol/sdk/server/streamableHttp.js'),
  ])
  const server = new McpServer({ name: host.serverName, version })
  for (const tool of host.tools) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      async (input: Record<string, unknown>) =>
        textResult(await callAgentTool(tool, input, context)),
    )
  }
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })
  response.on('close', () => {
    void transport.close()
    void server.close()
  })
  await server.connect(transport)
  await transport.handleRequest(request, response)
}

/** Build Claude Code's in-process server from the host's tools. */
export function claudeMcpTools(
  host: Pick<AgentToolsHost, 'tools'>,
  context: AgentToolContext,
): Array<{
  name: string
  description: string
  inputSchema: Record<string, z.ZodType>
  handler: (input: Record<string, unknown>) => Promise<ReturnType<typeof textResult>>
}> {
  return host.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    handler: async (input) => textResult(await callAgentTool(tool, input, context)),
  }))
}
