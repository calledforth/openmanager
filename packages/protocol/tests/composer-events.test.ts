import { describe, expect, it } from 'vitest'
import {
  ComposerCommandOptionSchema,
  ComposerConfigOptionSchema,
  ProofEventSchemas,
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
