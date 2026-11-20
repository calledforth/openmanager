import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { BackendEvent } from '../../backends/Backend.js'
import { InteractionBroker } from '../../core/InteractionBroker.js'
import { PermissionBroker } from '../../core/PermissionBroker.js'
import { codex } from '../../providers/codex.js'
import { CodexSessionRuntime } from './CodexSessionRuntime.js'

/** One real turn against the `codex` on this machine. Opt in with
 * `OPENMANAGER_LIVE_CODEX_TURNS=1`: unlike the other live tests this spends
 * tokens (a one-word answer at low effort). */
const live = process.env.OPENMANAGER_LIVE_CODEX_TURNS === '1'

describe.skipIf(!live)('Codex session runtime, live', () => {
  it('runs a turn, resumes the thread, and runs another', { timeout: 180_000 }, async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'openmanager-codex-turn-'))
    const events: BackendEvent[] = []
    const deps = {
      config: codex,
      host: { log: vi.fn() },
      permissions: new PermissionBroker(),
      interactions: new InteractionBroker(),
    }
    const first = new CodexSessionRuntime({ threadId: 't1', providerId: 'codex', cwd }, deps)
    first.events((event) => events.push(event))
    try {
      const started = await first.start()
      expect(started.state).toBe('created')
      await first.prompt({
        prompt: {
          text: 'Reply with exactly the word: pong',
          blocks: [{ type: 'text', text: 'Reply with exactly the word: pong' }],
        },
        userMessageId: 'u1',
        desiredConfig: { modelId: process.env.OPENMANAGER_LIVE_CODEX_MODEL ?? 'gpt-6-luna' },
      })
      const text = events
        .filter((e) => e.event === 'agent_message_chunk')
        .map((e) => (e.data as { content: { text: string } }).content.text)
        .join('')
      expect(text.toLowerCase()).toContain('pong')
      expect(events.map((e) => e.event)).toContain('prompt_completed')
      await first.stop({ reason: 'disposed' })

      // A new process picks the same thread back up.
      const second = new CodexSessionRuntime(
        { threadId: 't1', providerId: 'codex', cwd, sessionId: started.sessionId },
        deps,
      )
      const resumed: BackendEvent[] = []
      second.events((event) => resumed.push(event))
      await expect(second.start()).resolves.toMatchObject({
        sessionId: started.sessionId,
        state: 'loaded',
      })
      await second.prompt({
        prompt: {
          text: 'What word did you just reply with? One word.',
          blocks: [{ type: 'text', text: 'What word did you just reply with? One word.' }],
        },
        userMessageId: 'u2',
        desiredConfig: { modelId: process.env.OPENMANAGER_LIVE_CODEX_MODEL ?? 'gpt-6-luna' },
      })
      const recalled = resumed
        .filter((e) => e.event === 'agent_message_chunk')
        .map((e) => (e.data as { content: { text: string } }).content.text)
        .join('')
      expect(recalled.toLowerCase()).toContain('pong')
      await second.stop({ reason: 'disposed' })
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
