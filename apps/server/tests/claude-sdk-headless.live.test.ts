import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent } from '@agentpack/contract'
import { describe, expect, it } from 'vitest'
import { mountAgentRuntime } from '../src/agent-runtime.js'
import { createLogger } from '../src/logger.js'

const live = process.env.OPENMANAGER_LIVE_CLAUDE === '1'
const promptText = 'Do not use tools. Reply with only the single word: pong'
const ORG_BLOCKED = /organization has disabled Claude subscription/i

describe.skipIf(!live)('Claude SDK headless stream', () => {
  it(
    'streams a turn through the mounted server runtime on this host',
    { timeout: 120_000 },
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'openmanager-claude-live-'))
      const events: AgentEvent[] = []
      const runtime = mountAgentRuntime(createLogger('warn'), (event) => events.push(event))
      const route = {
        providerId: 'claude' as const,
        threadId: 'claude-headless-live',
        cwd,
        desiredConfig: { modeId: 'dontAsk' },
      }
      try {
        const session = await runtime.ensureSession(route)
        expect(session.sessionId).toBeTruthy()
        expect(events.some((event) => event.event === 'process_spawned')).toBe(true)
        expect(events.some((event) => event.event === 'initialized')).toBe(true)
        expect(events.some((event) => event.event === 'session_created')).toBe(true)

        await runtime
          .prompt({
            ...route,
            prompt: { text: promptText, blocks: [{ type: 'text', text: promptText }] },
          })
          .catch(() => undefined)

        expect(events.some((event) => event.event === 'prompt_started')).toBe(true)
        const chunks = events
          .filter((event) => event.event === 'agent_message_chunk')
          .flatMap((event) => {
            const content = (event.data as { content?: { type?: string; text?: string } }).content
            return content?.type === 'text' && content.text ? [content.text] : []
          })
          .join('')
        expect(chunks.length).toBeGreaterThan(0)
        if (!ORG_BLOCKED.test(chunks)) {
          expect(chunks.toLowerCase()).toContain('pong')
          expect(events.some((event) => event.event === 'prompt_completed')).toBe(true)
        }
      } finally {
        await runtime.shutdown()
        await rm(cwd, { recursive: true, force: true })
      }
    },
  )
})
