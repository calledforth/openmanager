import { describe, expect, it } from 'vitest'
import type { EnvironmentState } from '@openmanager/environment-client'
import { selectModelReroute } from './model-reroute'

const notice = (turnId: string, to: string) => ({
  noticeId: `n-${turnId}-${to}`,
  turnId,
  kind: 'model_fallback' as const,
  message: `Codex moved this turn to ${to}`,
  model: { from: 'sol', to },
  detail: 'Flagged as high-risk.',
})

const state = (turns: string[], notices: ReturnType<typeof notice>[]) =>
  ({
    sessions: { s1: { threadIds: ['t1'] } },
    threads: { t1: { turns: turns.map((turnId) => ({ turnId })), notices } },
  }) as unknown as EnvironmentState

describe('selectModelReroute', () => {
  it('reads the newest turn’s last model switch', () => {
    const read = selectModelReroute(state(['a', 'b'], [notice('b', 'luna'), notice('b', 'mini')]), 's1')
    expect(read).toEqual({ to: 'mini', from: 'sol', detail: 'Flagged as high-risk.' })
  })

  it('forgets a reroute once a newer turn has started', () => {
    expect(selectModelReroute(state(['a', 'b'], [notice('a', 'luna')]), 's1')).toBeNull()
    expect(selectModelReroute(state([], []), 's1')).toBeNull()
    expect(selectModelReroute(state(['a'], []), 'missing')).toBeNull()
  })

  it('answers with the same object for the same notice', () => {
    const notices = [notice('a', 'luna')]
    expect(selectModelReroute(state(['a'], notices), 's1')).toBe(
      selectModelReroute(state(['a'], notices), 's1'),
    )
  })
})
