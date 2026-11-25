import { describe, expect, it } from 'vitest'
import { describeProviderFailure } from './provider-failure.js'

const NOW = Date.parse('2026-11-25T12:00:00.000Z')
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString()

describe('describeProviderFailure', () => {
  it('reads SIGKILL as the out-of-memory killer', () => {
    expect(
      describeProviderFailure(
        { kind: 'crash', at: minutesAgo(3), message: 'x', exitCode: null, signal: 'SIGKILL' },
        NOW,
      ),
    ).toBe(
      'A session process was killed (SIGKILL) 3m ago, most likely by the out-of-memory killer: the machine ran out of RAM.',
    )
  })

  it('reads exit code 137 the same way, as a shell or wsl.exe reports it', () => {
    expect(
      describeProviderFailure(
        { kind: 'crash', at: minutesAgo(0), message: 'x', exitCode: 137, signal: null },
        NOW,
      ),
    ).toMatch(/killed \(SIGKILL\) just now, most likely by the out-of-memory killer/)
  })

  it('says how any other crash ended', () => {
    expect(
      describeProviderFailure(
        { kind: 'crash', at: minutesAgo(90), message: 'x', exitCode: 1, signal: null },
        NOW,
      ),
    ).toBe('A session process crashed 1h ago (exit code 1).')
    expect(
      describeProviderFailure(
        { kind: 'crash', at: minutesAgo(2), message: 'x', exitCode: null, signal: 'SIGSEGV' },
        NOW,
      ),
    ).toBe('A session process crashed 2m ago (signal SIGSEGV).')
  })

  it('quotes the failure for starts and probes', () => {
    expect(
      describeProviderFailure(
        { kind: 'start_failed', at: minutesAgo(1), message: 'cursor exited during startup' },
        NOW,
      ),
    ).toBe('A session failed to start 1m ago: cursor exited during startup')
    expect(
      describeProviderFailure(
        { kind: 'probe_timeout', at: minutesAgo(4), message: 'did not answer within 30000ms' },
        NOW,
      ),
    ).toBe('The health check did not answer in time 4m ago; the machine may be overloaded.')
  })
})
