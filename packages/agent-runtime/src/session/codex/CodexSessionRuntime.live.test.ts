import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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

/** Settings between turns against the real `codex`: no turn, so no tokens.
 * Opt in with `OPENMANAGER_LIVE_CODEX=1`. */
describe.skipIf(process.env.OPENMANAGER_LIVE_CODEX !== '1')('Codex session settings, live', () => {
  it('changes effort, speed and access through thread/settings/update and reads them back', { timeout: 60_000 }, async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'openmanager-codex-settings-'))
    const events: BackendEvent[] = []
    const runtime = new CodexSessionRuntime(
      { threadId: 't-settings', providerId: 'codex', cwd },
      {
        config: codex,
        host: { log: vi.fn() },
        permissions: new PermissionBroker(),
        interactions: new InteractionBroker(),
      },
    )
    runtime.events((event) => events.push(event))
    const current = (id: string) => {
      const last = [...events]
        .reverse()
        .find((e) => e.event === 'config_option_update' || e.event === 'session_created')
      return (last?.data as { configOptions: Array<{ id: string; currentValue: unknown }> }).configOptions.find(
        (option) => option.id === id,
      )?.currentValue
    }
    try {
      await runtime.start()
      await runtime.setConfigOption('effort', 'high')
      expect(current('effort')).toBe('high')
      await runtime.setConfigOption('service_tier', 'priority')
      expect(current('service_tier')).toBe('priority')
      await runtime.setConfigOption('service_tier', 'default')
      expect(current('service_tier')).toBe('default')
      await runtime.setMode('supervised')
      expect(events.filter((e) => e.event === 'current_mode_update').at(-1)?.data).toMatchObject({
        currentModeId: 'supervised',
      })
    } finally {
      await runtime.stop({ reason: 'disposed' })
      await rm(cwd, { recursive: true, force: true })
    }
  })
})

/** Spends tokens like the turn test: a small review and a compaction. */
describe.skipIf(!live)('Codex operation turns, live', () => {
  it('runs /review on uncommitted changes, then /compact, as operation turns (CAL-268)', { timeout: 300_000 }, async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'openmanager-codex-ops-'))
    const git = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' })
    git('init', '-q')
    git('-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init')
    await writeFile(join(cwd, 'add.js'), 'export function add(a, b) {\n  return a - b\n}\n')
    const events: BackendEvent[] = []
    const runtime = new CodexSessionRuntime(
      { threadId: 't1', providerId: 'codex', cwd },
      {
        config: codex,
        host: { log: vi.fn() },
        permissions: new PermissionBroker(),
        interactions: new InteractionBroker(),
      },
    )
    runtime.events((event) => events.push(event))
    const command = (text: string) => ({ text, blocks: [{ type: 'text' as const, text }] })
    try {
      await runtime.start()
      await runtime.prompt({
        prompt: command('/review'),
        operation: { kind: 'review', target: { type: 'uncommitted_changes' } },
        desiredConfig: { modelId: process.env.OPENMANAGER_LIVE_CODEX_MODEL ?? 'gpt-6-luna' },
      })
      const notices = events.filter((e) => e.event === 'provider_notice').map((e) => e.data as { review?: unknown })
      expect(notices.filter((notice) => notice.review)).toEqual([
        expect.objectContaining({ review: expect.objectContaining({ phase: 'started' }) }),
        expect.objectContaining({ review: { phase: 'finished' } }),
      ])
      expect(events.filter((e) => e.event === 'agent_message_chunk').length).toBe(1)
      expect(events.map((e) => e.event)).not.toContain('background_turn_started')

      events.length = 0
      await runtime.prompt({ prompt: command('/compact'), operation: { kind: 'compact' } })
      expect(
        events.filter((e) => e.event === 'provider_notice').map((e) => (e.data as { kind: string }).kind),
      ).toEqual(expect.arrayContaining(['compacting', 'compacted']))
      expect(events.map((e) => e.event)).toContain('usage_update')
      expect(events.find((e) => e.event === 'prompt_completed')).toMatchObject({ data: { stopReason: 'end_turn' } })
    } finally {
      await runtime.stop({ reason: 'disposed' })
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
