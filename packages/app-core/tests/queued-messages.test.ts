import { describe, expect, it } from 'vitest'
import { queuedMessagePreview, queuedSettingsLabel } from '../src/components/chat/QueuedMessages'
import {
  readEnterWhileRunning,
  writeEnterWhileRunning,
} from '../src/components/chat/enterWhileRunning'
import type { DeviceStorage } from '../src/providers/device-host'

const names = {
  model: (modelId: string) =>
    ({ 'claude-opus': 'Opus 5', 'claude-sonnet': 'Sonnet 5' })[modelId] ?? modelId,
  effortId: 'effort',
  effortValue: (value: string) => ({ high: 'High', low: 'Low' })[value] ?? value,
}

describe('a queued message chip', () => {
  it('reads as one line of its text, or says it is only images', () => {
    expect(queuedMessagePreview({ text: '  fix the\n\nlogin   bug ' })).toBe('fix the login bug')
    expect(queuedMessagePreview({ text: '', artifactIds: ['a'] })).toBe('An image')
    expect(queuedMessagePreview({ text: ' ', artifactIds: ['a', 'b'] })).toBe('2 images')
  })

  it('names what it runs with only where that differs from the composer now', () => {
    const current = { modelId: 'claude-opus', configValues: { effort: 'high' } }
    expect(
      queuedSettingsLabel(
        { modelId: 'claude-opus', configValues: { effort: 'high' } },
        current,
        names,
      ),
    ).toBeNull()
    expect(
      queuedSettingsLabel(
        { modelId: 'claude-sonnet', configValues: { effort: 'high' } },
        current,
        names,
      ),
    ).toBe('Sonnet 5')
    expect(
      queuedSettingsLabel(
        { modelId: 'claude-sonnet', configValues: { effort: 'low' } },
        current,
        names,
      ),
    ).toBe('Sonnet 5 · Low')
    expect(queuedSettingsLabel({ configValues: { effort: 'low' } }, current, names)).toBe('Low')
    expect(
      queuedSettingsLabel({ configValues: { effort: 'high', fast: true } }, current, names),
    ).toBe('Earlier settings')
    // Captured with nothing: it runs as the session reads.
    expect(queuedSettingsLabel({}, current, names)).toBeNull()
  })

  it('finds the effort under the name the provider gives it', () => {
    expect(
      queuedSettingsLabel(
        { configValues: { reasoning_effort: 'medium' } },
        { configValues: { reasoning_effort: 'high' } },
        { model: (id) => id },
      ),
    ).toBe('medium')
  })
})

describe('what Enter does while a turn runs', () => {
  const memory = (): DeviceStorage & { values: Map<string, string> } => {
    const values = new Map<string, string>()
    return {
      values,
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => void values.set(key, value),
      removeItem: (key) => void values.delete(key),
    }
  }

  it('queues unless this device chose to steer', () => {
    const storage = memory()
    expect(readEnterWhileRunning(storage)).toBe('queue')
    writeEnterWhileRunning('steer', storage)
    expect(readEnterWhileRunning(storage)).toBe('steer')
    storage.values.set('openmanager-enter-while-running', 'nonsense')
    expect(readEnterWhileRunning(storage)).toBe('queue')
    expect(readEnterWhileRunning(null)).toBe('queue')
  })
})
