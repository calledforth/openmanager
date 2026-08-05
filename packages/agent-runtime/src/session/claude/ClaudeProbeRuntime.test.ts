import { describe, expect, it, vi } from 'vitest'
import type { SDKControlInitializeResponse } from '@anthropic-ai/claude-agent-sdk'
import { claude } from '../../providers/claude.js'
import { ClaudeProbeRuntime } from './ClaudeProbeRuntime.js'
import { FakeClaudeSdk } from './test-sdk.js'

const SPEC = { providerId: 'claude', cwd: 'C:/workspace' } as const

/** The probe never spawns anything real here: `version` is stubbed so the test
 * does not need Claude Code installed, and `env` points the executable
 * resolver at this process's own node binary so the real resolution path still
 * runs. */
function build(initialize?: Partial<SDKControlInitializeResponse>) {
  const sdk = new FakeClaudeSdk()
  if (initialize) sdk.initialize = { ...sdk.initialize, ...initialize }
  const log = vi.fn()
  const probe = new ClaudeProbeRuntime(
    { ...SPEC },
    {
      config: claude,
      host: { log },
      sdk,
      env: { CLAUDE_CODE_BIN: process.execPath },
      version: async () => '2.1.220',
    },
  )
  return { probe, sdk, log }
}

describe('ClaudeProbeRuntime models', () => {
  it('reports the catalog the handshake carried', async () => {
    const { probe } = build({
      models: [
        {
          value: 'sonnet',
          resolvedModel: 'claude-sonnet-5',
          displayName: 'Sonnet',
          description: 'Balanced capability and speed',
        },
        { value: 'opus', displayName: 'Opus', description: 'Most capable' },
      ],
    } as Partial<SDKControlInitializeResponse>)

    const result = await probe.probe()

    // `value` is the id, because that is what the CLI accepts back. Nothing
    // hand-written survives: a model the installed CLI did not list must not
    // appear, and one it did list must appear even though this repo has never
    // heard of it.
    expect(result.models?.availableModels).toEqual([
      {
        id: 'sonnet',
        displayName: 'Sonnet',
        description: 'Balanced capability and speed',
        resolvedModel: 'claude-sonnet-5',
      },
      { id: 'opus', displayName: 'Opus', description: 'Most capable' },
    ])
    await probe.dispose()
  })

  it('answers listModels from the same handshake, without a second CLI', async () => {
    const { probe, sdk } = build({
      models: [{ value: 'haiku', displayName: 'Haiku', description: 'Fastest' }],
    } as Partial<SDKControlInitializeResponse>)

    await probe.probe()
    const listing = await probe.listModels(SPEC.cwd)

    expect(listing.availableModels).toEqual([
      { id: 'haiku', displayName: 'Haiku', description: 'Fastest' },
    ])
    expect(sdk.queries).toHaveLength(1)
    await probe.dispose()
  })

  it('reports an empty catalog rather than a guessed one when the CLI sends none', async () => {
    // A CLI old enough to predate the field sends nothing at all, which the
    // SDK's own types say cannot happen. Offering a hand-written list here is
    // how you offer a model the installed CLI would reject.
    const { probe } = build({ models: undefined } as unknown as Partial<SDKControlInitializeResponse>)

    const result = await probe.probe()

    expect(result.models).toEqual({ availableModels: [] })
    await probe.dispose()
  })
})

describe('ClaudeProbeRuntime modes', () => {
  it('reports the permission-mode catalog without a session', async () => {
    // The CLI sends no modes at `initialize` — this catalog is static. It is
    // still reported from the probe, because the composer gates its mode
    // control on a non-empty list and every other source of one needs a live
    // session, so a never-used provider would render no mode control at all.
    const { probe } = build()

    const result = await probe.probe()

    expect(result.modes?.availableModes?.map((mode) => mode.id)).toEqual([
      'default',
      'acceptEdits',
      'plan',
      'auto',
      'dontAsk',
      'bypassPermissions',
    ])
    // Safe-first ordering is load-bearing: the composer falls back to the head
    // of this list whenever it has no better answer.
    expect(result.modes?.availableModes?.[0]).toMatchObject({
      id: 'default',
      displayName: 'Default',
    })
    expect(result.modes?.currentModeId).toBeUndefined()
    await probe.dispose()
  })

  it('describes every mode, including the ones whose names mislead', async () => {
    const { probe } = build()

    const result = await probe.probe()
    const byId = new Map(result.modes?.availableModes?.map((mode) => [mode.id, mode]))

    // "dontAsk" reads as "allow everything" and means the opposite.
    expect(byId.get('dontAsk')?.description).toMatch(/denies/i)
    expect(byId.get('bypassPermissions')?.description).toMatch(/without asking/i)
    expect([...byId.values()].every((mode) => !!mode.description)).toBe(true)
    await probe.dispose()
  })
})
