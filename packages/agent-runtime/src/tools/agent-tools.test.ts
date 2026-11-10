import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { InteractionBroker } from '../core/InteractionBroker.js'
import { PermissionBroker } from '../core/PermissionBroker.js'
import { claude } from '../providers/claude.js'
import { cursor } from '../providers/cursor.js'
import { opencode, opencodeAllowHostTools } from '../providers/opencode.js'
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

  it("answers the agent's own permission prompt for a host tool, and only for one", async () => {
    const { agentTools } = host()
    const connections = new FakeConnectionFactory({
      initialize: async () => ({
        protocolVersion: 1,
        authMethods: [],
        agentCapabilities: { mcpCapabilities: { http: true } },
      }),
      newSession: async () => ({ sessionId: 'session-1' }),
    })
    const permissions = new PermissionBroker(() => undefined)
    const runtime = new AcpSessionRuntimeImpl(
      { threadId: 'thread-1', providerId: cursor.id, cwd: 'C:/workspace' },
      {
        config: cursor,
        host: { log: vi.fn(), agentTools },
        permissions,
        interactions: new InteractionBroker(() => undefined),
        connections,
      },
    )
    await runtime.start()
    const options = [
      { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
      { optionId: 'no', name: 'Reject', kind: 'reject_once' },
    ]
    // Cursor's shape for an MCP tool.
    await expect(
      connections.last.requestPermission({
        sessionId: 'session-1',
        toolCall: {
          toolCallId: 'call-1',
          title: 'openmanager: link_pull_request',
          rawInput: { providerIdentifier: 'openmanager', toolName: 'link_pull_request', args: {} },
        },
        options,
      }),
    ).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'yes' } })
    // Anything else still goes to the user.
    let settled = false
    void connections.last
      .requestPermission({
        sessionId: 'session-1',
        toolCall: { toolCallId: 'call-2', title: 'Shell', rawInput: { command: 'rm -rf /' } },
        options,
      })
      .then(() => (settled = true))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(settled).toBe(false)
    await runtime.stop({ reason: 'disposed' })
  })

  it('never allows a call by its title, even one a tool call made before', async () => {
    const { agentTools } = host()
    const connections = new FakeConnectionFactory({
      initialize: async () => ({
        protocolVersion: 1,
        authMethods: [],
        agentCapabilities: { mcpCapabilities: { http: true } },
      }),
      newSession: async () => ({ sessionId: 'session-1' }),
    })
    const runtime = new AcpSessionRuntimeImpl(
      { threadId: 'thread-1', providerId: opencode.id, cwd: 'C:/workspace' },
      {
        config: { ...cursor, id: opencode.id, allowHostTools: opencodeAllowHostTools },
        host: { log: vi.fn(), agentTools },
        permissions: new PermissionBroker(() => undefined),
        interactions: new InteractionBroker(() => undefined),
        connections,
      },
    )
    await runtime.start()
    // OpenCode is told to allow the tool itself, by its exact tool id.
    expect(
      JSON.parse(connections.last.spec.env!.OPENCODE_CONFIG_CONTENT!) as unknown,
    ).toMatchObject({ permission: { openmanager_link_pull_request: 'allow' } })
    const options = [
      { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
      { optionId: 'no', name: 'Reject', kind: 'reject_once' },
    ]
    // OpenCode's real wire (1.19.5): a shell command spelled like the tool is
    // titled with the command; the MCP tool's own prompt has only its id.
    await connections.last.sessionUpdate({
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-shell',
        title: 'openmanager_link_pull_request',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { command: 'openmanager_link_pull_request' },
      },
    })
    const settled: string[] = []
    for (const toolCall of [
      {
        toolCallId: 'call-shell',
        title: 'openmanager_link_pull_request',
        kind: 'execute',
        rawInput: { command: 'openmanager_link_pull_request' },
      },
      {
        toolCallId: 'call-mcp',
        title: 'openmanager_link_pull_request',
        kind: 'other',
        rawInput: {},
      },
      { toolCallId: 'call-other', title: 'mcp__openmanager__link_pull_request', rawInput: {} },
    ]) {
      void connections.last
        .requestPermission({ sessionId: 'session-1', toolCall, options } as never)
        .then(() => settled.push(toolCall.toolCallId))
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(settled).toEqual([])
    await runtime.stop({ reason: 'disposed' })
  })

  it("extends a user's own OpenCode config rather than replacing it", () => {
    const tools = { serverName: 'openmanager', toolNames: ['link_pull_request'] }
    expect(opencodeAllowHostTools(tools, {})).toEqual({
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        permission: { openmanager_link_pull_request: 'allow' },
      }),
    })
    const extended = opencodeAllowHostTools(tools, {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: 'x', permission: 'ask' }),
    })
    expect(JSON.parse(extended.OPENCODE_CONFIG_CONTENT!)).toEqual({
      model: 'x',
      permission: { '*': 'ask', openmanager_link_pull_request: 'allow' },
    })
    // Not ours to rewrite: the tool then asks like any other.
    expect(opencodeAllowHostTools(tools, { OPENCODE_CONFIG_CONTENT: 'not json' })).toEqual({})
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
