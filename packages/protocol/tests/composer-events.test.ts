import { describe, expect, it } from 'vitest'
import {
  ComposerCommandOptionSchema,
  ComposerConfigOptionSchema,
  ComposerModelOptionSchema,
  ComposerUsageSchema,
  ProofEventSchemas,
  ProviderComposerProfileSchema,
  SessionComposerStateSchema,
  SessionSummarySchema,
} from '@openmanager/protocol'

describe('live composer state wire contract', () => {
  const event = (name: string, payload: unknown) => ({
    type: 'event',
    name,
    eventId: 'event-1',
    timestamp: '2026-09-19T00:00:00Z',
    scope: { type: 'environment', environmentId: 'env-1' },
    payload,
  })

  it('carries a whole session selection, so a repeated event is harmless', () => {
    const parsed = ProofEventSchemas['session.composer.updated'].parse(
      event('session.composer.updated', {
        sessionId: 'session-1',
        composer: { modelId: 'claude-opus', modeId: 'plan', configValues: { fast: true } },
      }),
    )
    expect(parsed.payload.composer).toEqual({
      modelId: 'claude-opus',
      modeId: 'plan',
      configValues: { fast: true },
    })
    // A session that has chosen nothing yet is still a valid selection.
    expect(SessionComposerStateSchema.parse({})).toEqual({})
  })

  it('rejects selections and config options the composer could not render', () => {
    expect(SessionComposerStateSchema.safeParse({ modelId: '' }).success).toBe(false)
    expect(SessionComposerStateSchema.safeParse({ model: 'claude-opus' }).success).toBe(false)
    expect(
      ComposerConfigOptionSchema.safeParse({
        type: 'select',
        id: 'effort',
        name: 'Effort',
        currentValue: 'high',
      }).success,
    ).toBe(false)
    expect(
      ComposerConfigOptionSchema.safeParse({
        type: 'boolean',
        id: 'fast',
        name: 'Fast mode',
        currentValue: 'yes',
      }).success,
    ).toBe(false)
  })

  it('lists slash commands by name, with the hint for what follows one', () => {
    const availableCommands = [
      { name: 'review', description: '' },
      { name: 'search', description: 'Search the workspace', placeholder: 'query' },
    ]
    expect(SessionComposerStateSchema.parse({ availableCommands })).toEqual({ availableCommands })
    expect(SessionComposerStateSchema.parse({ availableCommands: [] })).toEqual({
      availableCommands: [],
    })
    expect(ComposerCommandOptionSchema.safeParse({ name: '', description: '' }).success).toBe(false)
    // The ACP input spec stays host-side; only its hint crosses.
    expect(
      ComposerCommandOptionSchema.safeParse({
        name: 'search',
        description: '',
        input: { type: 'unstructured' },
      }).success,
    ).toBe(false)
  })

  it('carries context usage only when there is a window to measure against', () => {
    const usage = { used: 19_433, size: 200_000, cost: { amount: 0.42, currency: 'USD' } }
    expect(SessionComposerStateSchema.parse({ usage })).toEqual({ usage })
    expect(ComposerUsageSchema.parse({ used: 0, size: 200_000 })).toEqual({
      used: 0,
      size: 200_000,
    })
    expect(ComposerUsageSchema.safeParse({ used: 10, size: 0 }).success).toBe(false)
    expect(ComposerUsageSchema.safeParse({ used: -1, size: 200_000 }).success).toBe(false)
    expect(ComposerUsageSchema.safeParse({ used: 1.5, size: 200_000 }).success).toBe(false)
  })

  it('names the workspace and provider of a pushed preference', () => {
    const name = 'composer.preferences.updated'
    expect(
      ProofEventSchemas[name].safeParse(event(name, { preference: { modelId: 'claude-opus' } }))
        .success,
    ).toBe(false)
    expect(
      ProofEventSchemas[name].parse(
        event(name, { workspaceId: 'workspace-1', providerId: 'cursor', preference: {} }),
      ).payload.preference,
    ).toEqual({})
  })

  it('carries what a provider and each of its models accept in a prompt', () => {
    const name = 'provider.catalog.updated'
    const profile = {
      providerId: 'opencode',
      promptCapabilities: { image: true, audio: false, embeddedContext: false },
      availableModels: [
        { modelId: 'anthropic/claude-sonnet-4', name: 'Sonnet', supportsImageInput: true },
        { modelId: 'openai/o1-mini', name: 'o1 mini', supportsImageInput: false },
        // An ACP catalog carries no flag: unknown, not refused.
        { modelId: 'local/llama', name: 'Llama' },
      ],
      updatedAt: 1,
    }
    expect(ProofEventSchemas[name].parse(event(name, { profile })).payload.profile).toEqual(profile)
    // A handshake answers all three or none; a partial triple is not an answer.
    expect(
      ProviderComposerProfileSchema.safeParse({
        providerId: 'opencode',
        promptCapabilities: { image: true },
        updatedAt: 1,
      }).success,
    ).toBe(false)
    expect(
      ComposerModelOptionSchema.safeParse({ modelId: 'm', name: 'M', supportsImageInput: 'yes' })
        .success,
    ).toBe(false)
  })

  it('puts the selection on session summaries and keeps it optional', () => {
    const summary = {
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      title: null,
      status: 'idle',
      providerId: 'cursor',
      updatedAt: '2026-09-19T00:00:00Z',
    }
    expect(SessionSummarySchema.parse(summary)).not.toHaveProperty('composer')
    expect(
      SessionSummarySchema.parse({ ...summary, composer: { modelId: 'claude-opus' } }).composer,
    ).toEqual({ modelId: 'claude-opus' })
  })
})
