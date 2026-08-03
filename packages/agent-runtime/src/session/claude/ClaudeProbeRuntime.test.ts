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
      { id: 'sonnet', displayName: 'Sonnet', description: 'Balanced capability and speed' },
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
