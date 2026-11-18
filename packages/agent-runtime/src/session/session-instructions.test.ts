import { readFileSync } from 'node:fs'
import type { AgentEvent, PromptInput } from '@agentpack/contract'
import { describe, expect, it, vi } from 'vitest'
import type { BackendEvent } from '../backends/Backend.js'
import { AgentRuntime } from '../core/AgentRuntime.js'
import { InteractionBroker } from '../core/InteractionBroker.js'
import { PermissionBroker } from '../core/PermissionBroker.js'
import { claude } from '../providers/claude.js'
import { cursor } from '../providers/cursor.js'
import type { AcpProviderConfig } from '../providers/index.js'
import { opencode, opencodeInstructionsEnv } from '../providers/opencode.js'
import { AcpSessionRuntimeImpl, instructionsBlock } from './AcpSessionRuntimeImpl.js'
import type { SessionRuntimeSpec } from './SessionRuntime.js'
import { ClaudeSessionRuntime } from './claude/ClaudeSessionRuntime.js'
import { FakeClaudeSdk } from './claude/test-sdk.js'
import { FakeConnectionFactory, notify, type FakeWire } from './test-connection.js'

const INSTRUCTIONS = 'This project has a scratchpad at `.openmanager/scratchpad.md`.'
const PROMPT: PromptInput = { text: 'hi', blocks: [{ type: 'text', text: 'hi' }] }

const brokers = () => ({
  permissions: new PermissionBroker(() => undefined),
  interactions: new InteractionBroker(() => undefined),
})

function acp(config: AcpProviderConfig, spec: Partial<SessionRuntimeSpec>, wire: FakeWire = {}) {
  const prompts: unknown[] = []
  const events: BackendEvent[] = []
  const connections = new FakeConnectionFactory({
    newSession: async () => ({ sessionId: 'session-1' }),
    prompt: async (params) => {
      prompts.push((params as { prompt: unknown }).prompt)
      return { stopReason: 'end_turn' }
    },
    ...wire,
  })
  const runtime = new AcpSessionRuntimeImpl(
    {
      threadId: 'thread-1',
      workspaceId: 'workspace-1',
      cwd: 'C:/workspace',
      providerId: config.id,
      ...spec,
    },
    { config, host: { log: vi.fn(), onSessionTitle: vi.fn() }, ...brokers(), connections },
  )
  runtime.events((event) => events.push(event))
  return { runtime, connections, prompts, events }
}

describe('instructions over ACP', () => {
  it("go into OpenCode's own instructions, and no message carries them", async () => {
    const { runtime, connections, prompts } = acp(opencode, { instructions: INSTRUCTIONS })
    await runtime.start()
    const env = connections.last!.spec.env!
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT!) as { instructions: string[] }
    expect(config.instructions).toHaveLength(1)
    expect(readFileSync(config.instructions[0]!, 'utf8')).toBe(INSTRUCTIONS)
    await runtime.prompt({ prompt: PROMPT })
    expect(prompts).toEqual([PROMPT.blocks])
  })

  it('keep a list the user already passes OpenCode, and leave a config that is not JSON alone', () => {
    expect(
      JSON.parse(
        opencodeInstructionsEnv('/tmp/note.md', {
          OPENCODE_CONFIG_CONTENT: '{"instructions":["mine.md"],"model":"x"}',
        }).OPENCODE_CONFIG_CONTENT!,
      ),
    ).toEqual({ instructions: ['mine.md', '/tmp/note.md'], model: 'x' })
    expect(opencodeInstructionsEnv('/tmp/note.md', { OPENCODE_CONFIG_CONTENT: 'nope' })).toEqual({})
  })

  it('ride ahead of the first message of a new session where the agent has no place for them', async () => {
    const { runtime, connections, prompts, events } = acp(cursor, { instructions: INSTRUCTIONS })
    await runtime.start()
    expect(connections.last!.spec.env?.OPENCODE_CONFIG_CONTENT).toBeUndefined()
    await runtime.prompt({ prompt: PROMPT })
    await runtime.prompt({ prompt: PROMPT })
    expect(prompts).toEqual([
      [{ type: 'text', text: instructionsBlock(INSTRUCTIONS) }, ...PROMPT.blocks],
      PROMPT.blocks,
    ])
    // What the transcript records is the user's own text.
    const started = events.filter((event) => event.event === 'prompt_started')
    expect(started.map((event) => (event.data as { prompt: string }).prompt)).toEqual(['hi', 'hi'])
  })

  it('are not sent again to a session that already has them', async () => {
    const { runtime, prompts } = acp(
      cursor,
      { instructions: INSTRUCTIONS, sessionId: 'session-1' },
      { loadSession: async () => ({}) },
    )
    expect((await runtime.start()).state).toBe('loaded')
    await runtime.prompt({ prompt: PROMPT })
    expect(prompts).toEqual([PROMPT.blocks])
  })

  it('never show as the user speaking when the agent echoes them', async () => {
    const { runtime, connections, events } = acp(cursor, { instructions: INSTRUCTIONS })
    await runtime.start()
    const echo = (text: string) =>
      notify(connections.last!.client, {
        sessionId: 'session-1',
        update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } },
      })
    await echo(instructionsBlock(INSTRUCTIONS))
    await echo('hi')
    const echoed = events.filter((event) => event.event === 'user_message_chunk')
    expect(echoed.map((event) => (event.data as { content: unknown }).content)).toEqual([
      { type: 'text', text: 'hi' },
    ])
  })

  it('are left out entirely when there are none', async () => {
    const { runtime, connections, prompts } = acp(cursor, {})
    await runtime.start()
    await runtime.prompt({ prompt: PROMPT })
    expect(prompts).toEqual([PROMPT.blocks])
    const plain = acp(opencode, {})
    await plain.runtime.start()
    expect(plain.connections.last!.spec.env?.OPENCODE_CONFIG_CONTENT).toBeUndefined()
    expect(connections.connections).toHaveLength(1)
  })
})

describe('instructions for Claude Code', () => {
  function claudeRuntime(spec: Partial<SessionRuntimeSpec>) {
    const sdk = new FakeClaudeSdk()
    const runtime = new ClaudeSessionRuntime(
      {
        threadId: 'thread-1',
        workspaceId: 'workspace-1',
        cwd: 'C:/workspace',
        providerId: 'claude',
        ...spec,
      },
      {
        config: claude,
        host: { log: vi.fn(), onSessionTitle: vi.fn() },
        ...brokers(),
        sdk,
        env: { CLAUDE_CODE_BIN: process.execPath },
      },
    )
    return { runtime, sdk }
  }

  it('are the system prompt, standing in for the empty one the SDK sends by default', async () => {
    const { runtime, sdk } = claudeRuntime({ instructions: INSTRUCTIONS })
    await runtime.start()
    expect(sdk.last.options.systemPrompt).toBe(INSTRUCTIONS)
  })

  it('leave the system prompt as it was when there are none', async () => {
    const { runtime, sdk } = claudeRuntime({})
    await runtime.start()
    expect(sdk.last.options.systemPrompt).toBeUndefined()
  })
})

describe('the host deciding the instructions', () => {
  it('is asked as each process starts, for its workspace', async () => {
    const sdk = new FakeClaudeSdk()
    let note: string | undefined = INSTRUCTIONS
    const sessionInstructions = vi.fn(() => note)
    const runtime = new AgentRuntime(
      { emitEvent: (_event: AgentEvent) => undefined, log: vi.fn(), sessionInstructions },
      { cursor, opencode, claude },
      { claudeSdk: sdk },
    )
    vi.stubEnv('CLAUDE_CODE_BIN', process.execPath)
    try {
      const route = {
        providerId: 'claude' as const,
        workspaceId: 'workspace-1',
        cwd: 'C:/workspace',
      }
      await runtime.ensureSession({ ...route, threadId: 'thread-1' })
      expect(sessionInstructions).toHaveBeenCalledWith({
        providerId: 'claude',
        workspacePath: 'workspace-1',
        threadId: 'thread-1',
      })
      expect(sdk.queries[0]!.options.systemPrompt).toBe(INSTRUCTIONS)
      // Turned off: the next process hears nothing.
      note = undefined
      await runtime.ensureSession({ ...route, threadId: 'thread-2' })
      expect(sdk.queries[1]!.options.systemPrompt).toBeUndefined()
    } finally {
      vi.unstubAllEnvs()
      await runtime.shutdown()
    }
  })
})
