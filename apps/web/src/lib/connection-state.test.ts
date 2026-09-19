import { PROTOCOL_VERSION } from '@openmanager/protocol'
import { describe, expect, it } from 'vitest'
import { CONNECTION_STORIES, READY_CONNECTION_INPUT } from '../stories/connection-states'
import { bootstrapOutcomeFromQuery, deriveConnectionUi } from './connection-state'

/** Kinds that keep the shell mounted instead of replacing it. */
const BANNER_KINDS = new Set(['connecting', 'reconnecting', 'offline', 'unreachable'])

describe('deriveConnectionUi', () => {
  it('maps each story fixture to its named state and surface', () => {
    for (const story of CONNECTION_STORIES) {
      const ui = deriveConnectionUi(story.input)
      expect(ui.kind, story.id).toBe(story.id)
      expect(ui.surface, story.id).toBe(BANNER_KINDS.has(story.id) ? 'banner' : 'screen')
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

  it('reports no network as offline, with no action to take', () => {
    const ui = deriveConnectionUi({
      environment: { status: 'selected', endpoint: 'http://127.0.0.1:43120', label: 'Home' },
      bootstrap: { status: 'loading' },
      transport: { phase: 'reconnecting', hasConnected: true, failure: null },
      network: { online: false },
    })
    expect(ui).toMatchObject({ kind: 'offline', surface: 'banner', title: 'No network' })
    expect(ui.action).toBeUndefined()
    expect(ui.secondaryAction).toBeUndefined()
    expect(ui.description).toContain('reconnects')
  })

  it('reports exhausted retries as offline, with a manual retry', () => {
    const ui = deriveConnectionUi({
      environment: { status: 'selected', endpoint: 'http://127.0.0.1:43120', label: 'Home' },
      bootstrap: { status: 'loading' },
      transport: {
        phase: 'closed',
        hasConnected: true,
        failure: null,
        retriesExhausted: true,
      },
      network: { online: true },
    })
    expect(ui).toMatchObject({
      kind: 'offline',
      surface: 'banner',
      title: 'Not connected',
      action: 'retry',
      secondaryAction: 'change_environment',
    })
  })

  it('separates connecting, reconnecting and offline', () => {
    const environment = { status: 'selected' as const, endpoint: 'http://127.0.0.1:43120' }
    const first = deriveConnectionUi({
      environment,
      bootstrap: { status: 'loading' },
      transport: { phase: 'connecting', hasConnected: false, failure: null },
      network: { online: true },
    })
    const retrying = deriveConnectionUi({
      environment,
      bootstrap: { status: 'loading' },
      transport: { phase: 'connecting', hasConnected: true, failure: null },
      network: { online: true },
    })
    const gone = deriveConnectionUi({
      environment,
      bootstrap: { status: 'loading' },
      transport: { phase: 'connecting', hasConnected: true, failure: null },
      network: { online: false },
    })
    expect([first.kind, retrying.kind, gone.kind]).toEqual([
      'connecting',
      'reconnecting',
      'offline',
    ])
  })

  it('outranks a stale ready bootstrap when offline, but never an auth failure', () => {
    // The bootstrap succeeded before the network went away, so it proves nothing.
    expect(deriveConnectionUi({ ...READY_CONNECTION_INPUT, network: { online: false } }).kind).toBe(
      'offline',
    )
    expect(deriveConnectionUi({ ...READY_CONNECTION_INPUT, network: { online: true } }).kind).toBe(
      'ready',
    )
    expect(
      deriveConnectionUi({
        environment: { status: 'selected', endpoint: 'http://127.0.0.1:43120' },
        bootstrap: { status: 'unauthorized' },
        transport: { phase: 'closed', hasConnected: false, retriesExhausted: true, failure: null },
        network: { online: false },
      }).kind,
    ).toBe('unauthorized')
  })

  it('keeps a cached bootstrap while a later fetch is in flight', () => {
    const ready = {
      status: 'ready' as const,
      environmentId: 'env-local',
      label: 'Local environment',
      protocolVersion: PROTOCOL_VERSION,
    }
    expect(bootstrapOutcomeFromQuery(false, ready)).toEqual({ status: 'idle' })
    expect(bootstrapOutcomeFromQuery(true, undefined)).toEqual({ status: 'loading' })
    expect(bootstrapOutcomeFromQuery(true, ready)).toEqual(ready)
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
