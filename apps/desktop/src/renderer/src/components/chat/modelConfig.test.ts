import { describe, expect, it } from 'vitest'
import type { SessionConfigOption } from '@agentpack/contract'
import {
  applySessionConfigValues,
  configurableSessionOptions,
  isBooleanSelect,
  sessionConfigSummary,
  updateSessionConfigOptions,
} from './modelConfig'

const options: SessionConfigOption[] = [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: 'gpt-5.4',
    options: [{ value: 'gpt-5.4', name: 'GPT-5.4' }],
  },
  {
    id: 'reasoning',
    name: 'Reasoning',
    category: 'thought_level',
    type: 'select',
    currentValue: 'medium',
    options: [
      { value: 'none', name: 'None' },
      { value: 'medium', name: 'Medium' },
      { value: 'high', name: 'High' },
    ],
  },
  {
    id: 'fast',
    name: 'Fast',
    category: 'model_config',
    type: 'select',
    currentValue: 'false',
    options: [
      { value: 'false', name: 'Off' },
      { value: 'true', name: 'Fast' },
    ],
  },
]

describe('model configuration helpers', () => {
  it('keeps model and mode controls out of the secondary settings menu', () => {
    expect(configurableSessionOptions(options).map((option) => option.id)).toEqual([
      'reasoning',
      'fast',
    ])
  })

  it('summarizes meaningful selections and hides disabled toggles', () => {
    expect(sessionConfigSummary(options)).toEqual(['Medium'])
    const fast = updateSessionConfigOptions(options, 'fast', 'true')
    expect(sessionConfigSummary(fast)).toEqual(['Medium', 'Fast'])
  })

  it('recognizes select controls that represent booleans', () => {
    expect(isBooleanSelect(options[2])).toBe(true)
    expect(isBooleanSelect(options[1])).toBe(false)
  })

  it('applies only values advertised by the current model', () => {
    const updated = applySessionConfigValues(options, {
      reasoning: 'high',
      fast: 'true',
      stale: 'ignored',
    })
    expect(updated?.find((option) => option.id === 'reasoning')?.currentValue).toBe('high')
    expect(updated?.find((option) => option.id === 'fast')?.currentValue).toBe('true')
    expect(updated).toHaveLength(options.length)
  })
})
