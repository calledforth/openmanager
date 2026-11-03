import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it, vi } from 'vitest'
import { ClaudeMessageTranslator } from './ClaudeMessageTranslator.js'
import { claudeUsageObservation, claudeUsageReading } from './claude-usage-limits.js'

/** The `/usage` answer's shape as CLI 2.1.309 sent it (2026-11-02), numbers
 * changed. The code-named keys are the kind the mapping must ignore. */
const USAGE_RESPONSE = {
  session: { total_cost_usd: 0 },
  subscription_type: 'max',
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 37, resets_at: '2026-11-02T14:20:00.230157+00:00' },
    seven_day: { utilization: 62, resets_at: '2026-11-09T09:59:59.409184+00:00' },
    seven_day_oauth_apps: null,
    seven_day_opus: { utilization: 12, resets_at: '2026-11-09T10:00:00+00:00' },
    seven_day_sonnet: null,
    iguana_necktie: { utilization: 39, resets_at: '2026-11-05T07:59:00+00:00' },
    model_scoped: [
      { display_name: 'Fable', utilization: 18, resets_at: '2026-11-09T10:00:00+00:00' },
    ],
    extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
    limits: [{ kind: 'session', percent: 37 }],
  },
  behaviors: null,
}

describe('claudeUsageReading', () => {
  it('maps the typed windows in display order and ignores everything else', () => {
    expect(claudeUsageReading(USAGE_RESPONSE)).toEqual({
      windows: [
        {
          id: 'five_hour',
          label: '5-hour',
          group: 'session',
          usedPercent: 37,
          resetsAt: '2026-11-02T14:20:00.230Z',
          status: null,
        },
        {
          id: 'seven_day',
          label: 'Weekly · all models',
          group: 'weekly',
          usedPercent: 62,
          resetsAt: '2026-11-09T09:59:59.409Z',
          status: null,
        },
        {
          id: 'seven_day_opus',
          label: 'Weekly · Opus',
          group: 'weekly',
          usedPercent: 12,
          resetsAt: '2026-11-09T10:00:00.000Z',
          status: null,
        },
        {
          id: 'model:Fable',
          label: 'Weekly · Fable',
          group: 'weekly',
          usedPercent: 18,
          resetsAt: '2026-11-09T10:00:00.000Z',
          status: null,
        },
      ],
      extraUsage: { enabled: false, usedPercent: null },
    })
  })

  it('lets a per-model entry stand in for the fixed window of the same model', () => {
    const reading = claudeUsageReading({
      rate_limits_available: true,
      rate_limits: {
        seven_day_opus: { utilization: 12, resets_at: null },
        model_scoped: [{ display_name: 'Opus', utilization: 14, resets_at: null }],
      },
    })
    expect(reading?.windows.map((window) => [window.id, window.usedPercent])).toEqual([
      ['model:Opus', 14],
    ])
  })

  it('clamps percentages and marks a full window as limited', () => {
    const reading = claudeUsageReading({
      rate_limits_available: true,
      rate_limits: { five_hour: { utilization: 104, resets_at: 'not a date' } },
    })
    expect(reading?.windows).toEqual([
      {
        id: 'five_hour',
        label: '5-hour',
        group: 'session',
        usedPercent: 100,
        resetsAt: null,
        status: 'limited',
      },
    ])
  })

  it('says null for an account without plan limits', () => {
    expect(claudeUsageReading({ rate_limits_available: false, rate_limits: null })).toBeNull()
    expect(claudeUsageReading(undefined)).toBeNull()
  })
})

describe('claudeUsageObservation', () => {
  it('turns a warning into a status, a reset time and a lower bound', () => {
    expect(
      claudeUsageObservation({
        status: 'allowed_warning',
        rateLimitType: 'seven_day',
        resetsAt: 1_762_682_400,
        surpassedThreshold: 0.8,
        utilization: 0.83,
      }),
    ).toEqual({
      windowId: 'seven_day',
      label: 'Weekly · all models',
      group: 'weekly',
      status: 'warning',
      resetsAt: new Date(1_762_682_400_000).toISOString(),
      usedPercentAtLeast: 80,
    })
  })

  it('reads a refusal as the whole window used', () => {
    expect(
      claudeUsageObservation({ status: 'rejected', rateLimitType: 'five_hour' }),
    ).toMatchObject({ windowId: 'five_hour', status: 'limited', usedPercentAtLeast: 100 })
  })

  it('skips windows the contract does not name', () => {
    expect(claudeUsageObservation({ status: 'allowed', rateLimitType: 'overage' })).toBeUndefined()
    expect(claudeUsageObservation({ status: 'allowed' })).toBeUndefined()
  })
})

describe('rate_limit_event in a live session', () => {
  it('emits usage_limits_update whether or not a turn is open', () => {
    const translator = new ClaudeMessageTranslator({
      route: () => ({ threadId: 'thread-1', workspaceId: 'workspace-1' }),
      log: vi.fn(),
      turnOpen: () => false,
    })
    const { events } = translator.translate({
      type: 'rate_limit_event',
      session_id: 'session-1',
      uuid: 'frame-1',
      rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', resetsAt: 1_762_682_400 },
    } as unknown as SDKMessage)
    expect(events).toEqual([
      expect.objectContaining({
        sessionId: 'session-1',
        category: 'session',
        event: 'usage_limits_update',
        data: expect.objectContaining({ windowId: 'five_hour', status: 'ok' }),
      }),
    ])
  })
})
