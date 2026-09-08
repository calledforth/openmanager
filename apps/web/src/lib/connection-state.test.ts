import { describe, expect, it } from 'vitest'
import { CONNECTION_STORIES, READY_CONNECTION_INPUT } from '../stories/connection-states'
import { deriveConnectionUi } from './connection-state'

describe('deriveConnectionUi', () => {
  it('maps each story fixture to its named state and surface', () => {
    for (const story of CONNECTION_STORIES) {
      const ui = deriveConnectionUi(story.input)
      expect(ui.kind, story.id).toBe(story.id)
      expect(ui.surface, story.id).toBe(story.id === 'connecting' || story.id === 'reconnecting' || story.id === 'unreachable' ? 'banner' : 'screen')
      expect(ui.title.length, story.id).toBeGreaterThan(0)
      expect(ui.description.length, story.id).toBeGreaterThan(0)
    }
  })

  it('treats a successful bootstrap plus connected transport as ready', () => {
    const ui = deriveConnectionUi(READY_CONNECTION_INPUT)
    expect(ui).toMatchObject({ kind: 'ready', surface: 'none' })
  })

  it('prefers protocol mismatch over a later unreachable transport', () => {
    const ui = deriveConnectionUi({
      environment: {
        status: 'selected',
        endpoint: 'http://127.0.0.1:43120',
        label: 'Local environment',
      },
      bootstrap: {
        status: 'incompatible_protocol',
        clientProtocolVersion: 1,
        serverProtocolVersion: 9,
        label: 'Local environment',
      },
      transport: {
        phase: 'closed',
        hasConnected: true,
        failure: { code: 'unreachable' },
      },
    })
    expect(ui.kind).toBe('incompatible_protocol')
    expect(ui.surface).toBe('screen')
    expect(ui.description).toContain('protocol 1')
    expect(ui.description).toContain('protocol 9')
  })

  it('prefers unauthorized over reconnecting', () => {
    const ui = deriveConnectionUi({
      environment: { status: 'selected', endpoint: 'http://127.0.0.1:43120' },
      bootstrap: { status: 'unauthorized', message: 'Origin is not allowed.' },
      transport: { phase: 'reconnecting', hasConnected: true, failure: { code: 'auth' } },
    })
    expect(ui.kind).toBe('unauthorized')
    expect(ui.surface).toBe('screen')
    expect(ui.action).toBe('change_environment')
    expect(ui.description).toContain('Origin is not allowed.')
  })

  it('keeps reconnecting as a banner after a successful connection', () => {
    const ui = deriveConnectionUi({
      environment: { status: 'selected', endpoint: 'http://127.0.0.1:43120', label: 'Home' },
      bootstrap: { status: 'loading' },
      transport: { phase: 'reconnecting', hasConnected: true, failure: null },
    })
    expect(ui).toMatchObject({ kind: 'reconnecting', surface: 'banner', action: 'retry' })
    expect(ui.description).toContain('session stays here')
  })

  it('does not invent a failure from idle transport without an environment', () => {
    const ui = deriveConnectionUi({
      environment: { status: 'none' },
      bootstrap: { status: 'unreachable' },
      transport: { phase: 'closed', hasConnected: false, failure: { code: 'unreachable' } },
    })
    expect(ui.kind).toBe('no_environment')
  })
})
