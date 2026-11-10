import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { InteractionBroker } from '../core/InteractionBroker.js'
import { PermissionBroker } from '../core/PermissionBroker.js'
import { claude } from '../providers/claude.js'
import { cursor } from '../providers/cursor.js'
import { AcpSessionRuntimeImpl } from '../session/AcpSessionRuntimeImpl.js'
import { ClaudeSessionRuntime } from '../session/claude/ClaudeSessionRuntime.js'
import type { ClaudeMcpTool } from '../session/claude/sdk.js'
import { FakeClaudeSdk } from '../session/claude/test-sdk.js'
import { FakeConnectionFactory } from '../session/test-connection.js'
import type { AgentToolContext, AgentToolsHost } from './agent-tools.js'

function host() {
  const calls: { input: Record<string, unknown>; threadId: string }[] = []
  const closed: string[] = []
  const agentTools: AgentToolsHost = {
    serverName: 'openmanager',
    tools: [
      {
        name: 'link_pull_request',
        description: 'Link a pull request.',
        inputSchema: { url: z.string() },
        call: async (input, context) => {
          calls.push({ input, threadId: context.threadId })
          return { text: 'linked' }
        },
      },
    ],
    openRemote: (context: AgentToolContext) => ({
      http: { url: 'http://127.0.0.1:1/mcp', headers: { Authorization: 'Bearer secret' } },
      stdio: { command: 'node', args: ['main.ts', 'mcp-bridge'], env: { TOKEN: 'secret' } },
      close: () => closed.push(context.threadId),
    }),
  }
  return { agentTools, calls, closed }
}

const brokers = () => ({
  permissions: new PermissionBroker(() => undefined),
  interactions: new InteractionBroker(() => undefined),
})

describe('host tools on Claude Code', () => {
  it('serves them in process, pre-approved, bound to the thread', async () => {
    const { agentTools, calls } = host()
    const sdk = new FakeClaudeSdk()
    let built: readonly ClaudeMcpTool[] = []
    Object.assign(sdk, {
      createMcpServer: (name: string, tools: readonly ClaudeMcpTool[]) => {
        built = tools
        return { type: 'sdk', name, instance: {} }
      },
    })
    const runtime = new ClaudeSessionRuntime(
      { threadId: 'thread-1', providerId: 'claude', cwd: 'C:/workspace' },
      {
        config: claude,
        host: { log: vi.fn(), agentTools },
        ...brokers(),
        sdk,
        env: { CLAUDE_CODE_BIN: process.execPath },
      },
    )
    await runtime.start()
    const query = sdk.queries.at(-1)!
    expect(Object.keys(query.options.mcpServers ?? {})).toEqual(['openmanager'])
    expect(query.options.allowedTools).toEqual(['mcp__openmanager__link_pull_request'])
    // Allowed in the default mode, where any other tool would ask.
    await expect(
      query.useTool('mcp__openmanager__link_pull_request', { url: 'x' }).result,
    ).resolves.toMatchObject({ behavior: 'allow' })

    const answer = await built[0]!.handler({ url: 'https://github.com/o/r/pull/1' })
    expect(answer).toEqual({ content: [{ type: 'text', text: 'linked' }] })
    runtime.rebindThread('thread-2', undefined)
    await built[0]!.handler({ url: 'https://github.com/o/r/pull/2' })
    expect(calls.map((call) => call.threadId)).toEqual(['thread-1', 'thread-2'])
    await runtime.stop({ reason: 'disposed' })
  })

  it('turns a throwing tool into a tool error, not a failed call', async () => {
    const { agentTools } = host()
    agentTools.tools[0]!.call = async () => {
      throw new Error('boom')
    }
    const sdk = new FakeClaudeSdk()
    let built: readonly ClaudeMcpTool[] = []
    Object.assign(sdk, {
      createMcpServer: (name: string, tools: readonly ClaudeMcpTool[]) => {
        built = tools
        return { type: 'sdk', name, instance: {} }
      },
    })
    const runtime = new ClaudeSessionRuntime(
      { threadId: 'thread-1', providerId: 'claude', cwd: 'C:/workspace' },
      {
        config: claude,
        host: { log: vi.fn(), agentTools },
        ...brokers(),
        sdk,
        env: { CLAUDE_CODE_BIN: process.execPath },
      },
    )
    await runtime.start()
    await expect(built[0]!.handler({ url: 'x' })).resolves.toEqual({
      content: [{ type: 'text', text: 'link_pull_request failed: boom' }],
      isError: true,
    })
    await runtime.stop({ reason: 'disposed' })
  })
})

describe('host tools on ACP agents', () => {
  const run = async (http: boolean) => {
    const { agentTools, closed } = host()
    const sessions: unknown[] = []
    const connections = new FakeConnectionFactory({
      initialize: async () => ({
        protocolVersion: 1,
        authMethods: [],
        agentCapabilities: { mcpCapabilities: { http } },
      }),
      newSession: async (params) => {
        sessions.push(params)
        return { sessionId: 'session-1' }
      },
    })
    const runtime = new AcpSessionRuntimeImpl(
      { threadId: 'thread-1', providerId: cursor.id, cwd: 'C:/workspace' },
      { config: cursor, host: { log: vi.fn(), agentTools }, ...brokers(), connections },
    )
    await runtime.start()
    await runtime.stop({ reason: 'disposed' })
    return { sessions, closed }
  }

  it('passes the HTTP endpoint when the agent advertises HTTP MCP', async () => {
    const { sessions, closed } = await run(true)
    expect(sessions).toEqual([
      {
        cwd: 'C:/workspace',
        mcpServers: [
          {
            type: 'http',
            name: 'openmanager',
            url: 'http://127.0.0.1:1/mcp',
            headers: [{ name: 'Authorization', value: 'Bearer secret' }],
          },
        ],
      },
    ])
    // Revoked with the process.
    expect(closed).toEqual(['thread-1'])
  })

  it('falls back to the stdio bridge otherwise', async () => {
    const { sessions } = await run(false)
    expect(sessions).toEqual([
      {
        cwd: 'C:/workspace',
        mcpServers: [
          {
            name: 'openmanager',
            command: 'node',
            args: ['main.ts', 'mcp-bridge'],
            env: [{ name: 'TOKEN', value: 'secret' }],
          },
        ],
      },
    ])
  })
})
