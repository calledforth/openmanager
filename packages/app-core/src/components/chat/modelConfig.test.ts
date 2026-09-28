import { describe, expect, it } from 'vitest'
import type { SessionConfigOption } from '@agentpack/contract'
import {
  applySessionConfigValues,
  configurableSessionOptions,
  contextWindowConfigOption,
  effortConfigOption,
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
  it('keeps model, mode and effort controls out of the secondary settings menu', () => {
    // Effort has its own pill, whatever the provider calls it.
    expect(configurableSessionOptions(options).map((option) => option.id)).toEqual(['fast'])
  })

  it('summarizes meaningful selections and hides disabled toggles', () => {
    expect(sessionConfigSummary(options)).toEqual([])
    const fast = updateSessionConfigOptions(options, 'fast', 'true')
    expect(sessionConfigSummary(fast)).toEqual(['Fast'])
  })

  it('finds the effort control under every name the providers use', () => {
    expect(effortConfigOption(options)?.id).toBe('reasoning')
    // Cursor files a `thinking` on/off switch under the same category; it is
    // never the effort control, and it stays in the settings menu.
    const cursorOpus: SessionConfigOption[] = [
      {
        id: 'thinking',
        name: 'Thinking',
        category: 'thought_level',
        type: 'select',
        currentValue: 'true',
        options: [
          { value: 'false', name: 'Off' },
          { value: 'true', name: 'On' },
        ],
      },
      {
        id: 'effort',
        name: 'Effort',
        category: 'thought_level',
        type: 'select',
        currentValue: 'high',
        options: [
          { value: 'low', name: 'Low' },
          { value: 'high', name: 'High' },
        ],
      },
    ]
    expect(effortConfigOption(cursorOpus)?.id).toBe('effort')
    expect(configurableSessionOptions(cursorOpus).map((option) => option.id)).toEqual(['thinking'])
    expect(effortConfigOption([cursorOpus[0]])).toBeUndefined()
  })

  it('finds the context window control', () => {
    const context: SessionConfigOption = {
      id: 'context',
      name: 'Context',
      category: 'model_config',
      type: 'select',
      currentValue: '300k',
      options: [
        { value: '300k', name: '300K' },
        { value: '1m', name: '1M' },
      ],
    }
    expect(contextWindowConfigOption([...options, context])).toBe(context)
    expect(contextWindowConfigOption(options)).toBeUndefined()
    // It stays in the settings menu, and its choice shows in the summary.
    expect(sessionConfigSummary([context])).toEqual(['300K'])
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
