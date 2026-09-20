import { describe, expect, it } from 'vitest'
import {
  UNPROBED_PROVIDER_HEALTH,
  type ProviderHealth,
  type ProviderHealthReport,
} from '@openmanager/shared/contracts/provider-health'
import { describeProviderHealth } from './provider-health-view'

const NOW = Date.parse('2026-07-27T12:00:00.000Z')
const JUST_NOW = new Date(NOW - 30_000).toISOString()
const HOURS_AGO = new Date(NOW - 3 * 60 * 60 * 1000).toISOString()

function report(health: Partial<ProviderHealth>, refreshing = false): ProviderHealthReport {
  return {
    health: {
      ...UNPROBED_PROVIDER_HEALTH,
      lastProbe: { outcome: 'ok', at: JUST_NOW, durationMs: 900 },
      ...health,
    },
    refreshing,
  }
}

describe('describeProviderHealth', () => {
  it('says nothing has been checked yet rather than implying a fault', () => {
    const view = describeProviderHealth(undefined, NOW)
    expect(view).toMatchObject({ status: 'unknown', tone: 'muted', label: 'Not checked yet' })
    expect(view.detail).toBeUndefined()
  })

  it('reads a correctly-installed provider with no session open as ready', () => {
    const view = describeProviderHealth(
      report({
        install: { state: 'installed', version: '2026.07.23' },
        auth: { state: 'authenticated' },
        runtime: { state: 'never_started', liveProcesses: 0, activeTurns: 0 },
      }),
      NOW,
    )
    // This is the app-launch case: only one provider is started, and the other
    // used to render as "Unavailable" purely because it had not been started.
    expect(view).toMatchObject({
      status: 'ready',
      tone: 'ready',
      label: 'Ready',
      detail: 'No session running',
      canRetry: false,
    })
  })

  it('counts live sessions in the detail line', () => {
    const view = describeProviderHealth(
      report({
        install: { state: 'installed' },
        auth: { state: 'authenticated' },
        runtime: { state: 'running', liveProcesses: 2, activeTurns: 1 },
      }),
      NOW,
    )
    expect(view.detail).toBe('2 sessions running')
  })

  it('offers the login hint when the CLI is installed but not signed in', () => {
    const view = describeProviderHealth(
      report({
        install: { state: 'installed' },
        auth: {
          state: 'unauthenticated',
          message: 'not signed in',
          loginHint: 'Run `opencode auth login` and retry.',
        },
      }),
      NOW,
    )
    expect(view).toMatchObject({
      status: 'auth_required',
      tone: 'warning',
      label: 'Sign-in required',
      detail: 'Run `opencode auth login` and retry.',
      canRetry: true,
    })
  })

  it('distinguishes a missing CLI from a broken one', () => {
    const missing = describeProviderHealth(
      report({ install: { state: 'missing', message: 'spawn cursor-agent ENOENT' } }),
      NOW,
    )
    expect(missing).toMatchObject({
      status: 'binary_missing',
      tone: 'error',
      label: 'CLI not found',
      detail: 'spawn cursor-agent ENOENT',
    })

    const broken = describeProviderHealth(
      report({ install: { state: 'unusable', message: 'exited during startup (code 1)' } }),
      NOW,
    )
    expect(broken).toMatchObject({ status: 'failed', tone: 'error', label: 'Unavailable' })
  })

  it('surfaces a crashed session while others keep running', () => {
    const view = describeProviderHealth(
      report({
        install: { state: 'installed' },
        auth: { state: 'authenticated' },
        runtime: {
          state: 'degraded',
          liveProcesses: 2,
          activeTurns: 0,
          message: 'Session process exited unexpectedly (code 1, signal none)',
        },
      }),
      NOW,
    )
    expect(view).toMatchObject({
      status: 'degraded',
      tone: 'warning',
      label: 'Running with errors',
      canRetry: true,
    })
  })

  it('reports a provider whose last process died as unavailable', () => {
    const view = describeProviderHealth(
      report({
        install: { state: 'installed' },
        auth: { state: 'authenticated' },
        runtime: {
          state: 'failed',
          liveProcesses: 0,
          activeTurns: 0,
          message: 'Session process exited unexpectedly (code 1, signal none)',
        },
      }),
      NOW,
    )
    expect(view).toMatchObject({ status: 'failed', label: 'Unavailable', canRetry: true })
    expect(view.detail).toMatch(/exited unexpectedly/)
  })

  it('ages a restored boot snapshot out instead of replaying its verdict', () => {
    const stale = {
      install: { state: 'missing' as const, message: 'spawn cursor-agent ENOENT' },
      lastProbe: { outcome: 'failed' as const, at: HOURS_AGO, durationMs: 40 },
    }
    // Not "CLI not found": that was three hours ago and may well be fixed.
    expect(describeProviderHealth(report(stale), NOW)).toMatchObject({
      status: 'unknown',
      label: 'Not checked yet',
      detail: 'Last checked 3h ago',
    })
    // ...and while the first probe of this run is in flight, say so.
    expect(describeProviderHealth(report(stale, true), NOW)).toMatchObject({
      status: 'probing',
      label: 'Checking…',
      detail: 'Last checked 3h ago',
      canRetry: false,
    })
  })

  it('says it is re-checking a provider the user just retried', () => {
    const broken = {
      install: { state: 'missing' as const, message: 'spawn cursor-agent ENOENT' },
      lastProbe: { outcome: 'failed' as const, at: JUST_NOW, durationMs: 40 },
    }
    expect(describeProviderHealth(report(broken), NOW).status).toBe('binary_missing')
    expect(describeProviderHealth(report(broken, true), NOW).status).toBe('probing')
  })

  it('does not flicker a working provider while it is re-probed in the background', () => {
    const working = {
      install: { state: 'installed' as const },
      auth: { state: 'authenticated' as const },
    }
    expect(describeProviderHealth(report(working, true), NOW)).toMatchObject({
      status: 'ready',
      label: 'Ready',
    })
  })

  it('trusts a live process over a stale probe timestamp', () => {
    const view = describeProviderHealth(
      report({
        install: { state: 'installed' },
        auth: { state: 'authenticated' },
        runtime: { state: 'running', liveProcesses: 1, activeTurns: 0 },
        lastProbe: { outcome: 'ok', at: HOURS_AGO, durationMs: 900 },
      }),
      NOW,
    )
    expect(view).toMatchObject({ status: 'ready', detail: '1 session running' })
  })
})
