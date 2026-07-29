import type { SessionConfigOption } from '@agentpack/contract'
import { describe, expect, it } from 'vitest'
import { AppliedConfigCache } from './AppliedConfigCache.js'

// Shapes taken from live cursor-agent responses: the model option carries
// category 'model', reasoning effort is a select, `fast` is a plain boolean.
const modelOption: SessionConfigOption = {
  type: 'select',
  id: 'model',
  name: 'Model',
  category: 'model',
  currentValue: 'claude-opus-5',
  options: [
    { value: 'claude-opus-5', name: 'Opus 5' },
    { value: 'composer-2.5', name: 'Composer 2.5' },
  ],
}
const effortOption: SessionConfigOption = {
  type: 'select',
  id: 'effort',
  name: 'Effort',
  currentValue: 'low',
  options: [
    { value: 'low', name: 'Low' },
    { value: 'high', name: 'High' },
  ],
}
const fastOption: SessionConfigOption = {
  type: 'boolean',
  id: 'fast',
  name: 'Fast',
  currentValue: false,
}

const seeded = (...options: SessionConfigOption[]) => {
  const cache = new AppliedConfigCache()
  cache.refresh(options, 'session/new', '2026-07-27T00:00:00.000Z')
  return cache
}

describe('AppliedConfigCache', () => {
  it('reports no state before a wire response has been folded in', () => {
    expect(new AppliedConfigCache().state).toBeUndefined()
    expect(new AppliedConfigCache().decide('effort', 'high')).toEqual({
      decision: 'unsupported',
      configId: 'effort',
    })
  })

  it('discovers the model option id from the category', () => {
    const cache = seeded(modelOption, effortOption)
    expect(cache.modelConfigId).toBe('model')
    expect(cache.state).toMatchObject({
      modelConfigId: 'model',
      refreshedAt: '2026-07-27T00:00:00.000Z',
      source: 'session/new',
    })
  })

  it('short-circuits a value that already matches', () => {
    const cache = seeded(modelOption, fastOption)
    expect(cache.decide('model', 'claude-opus-5')).toMatchObject({ decision: 'satisfied' })
    expect(cache.decide('fast', false)).toMatchObject({ decision: 'satisfied' })
    expect(cache.decide('model', 'composer-2.5')).toMatchObject({
      decision: 'apply',
      value: 'composer-2.5',
    })
  })

  it('refuses an option the current model does not expose', () => {
    // composer-2.5 advertises only mode/model/fast; sending `effort` fails
    // with "Unknown model config option" after burning ~1.4s.
    const cache = seeded(modelOption, fastOption)
    expect(cache.decide('effort', 'high')).toEqual({ decision: 'unsupported', configId: 'effort' })
  })

  it('refuses a value the option does not advertise', () => {
    const cache = seeded(effortOption)
    expect(cache.decide('effort', 'xhigh')).toMatchObject({ decision: 'invalid', value: 'xhigh' })
  })

  it('coerces booleans for options exposed as true/false selects', () => {
    const booleanAsSelect: SessionConfigOption = {
      type: 'select',
      id: 'thinking',
      name: 'Thinking',
      currentValue: 'false',
      options: [
        { value: 'true', name: 'On' },
        { value: 'false', name: 'Off' },
      ],
    }
    const cache = seeded(booleanAsSelect)
    expect(cache.decide('thinking', false)).toMatchObject({ decision: 'satisfied' })
    expect(cache.decide('thinking', true)).toMatchObject({ decision: 'apply' })
  })

  it('replaces the option list wholesale so dropped options disappear', () => {
    const cache = seeded(modelOption, effortOption)
    cache.refresh(
      [{ ...modelOption, currentValue: 'composer-2.5' }, fastOption],
      'session/set_config_option',
    )
    expect(cache.option('effort')).toBeUndefined()
    expect(cache.decide('model', 'composer-2.5')).toMatchObject({ decision: 'satisfied' })
  })

  it('plans the model first and flags the rest as stale when it changes', () => {
    const cache = seeded(modelOption, effortOption, fastOption)
    const plan = cache.plan({
      modelId: 'composer-2.5',
      values: { effort: 'high', fast: true },
    })
    expect(plan.model).toMatchObject({ decision: 'apply', configId: 'model' })
    expect(plan.staleAfterModelChange).toBe(true)
    expect(plan.values.map((entry) => entry.decision)).toEqual(['apply', 'apply'])
    expect(plan.legacySetModel).toBe(false)
  })

  it('emits an empty plan when everything already matches', () => {
    const cache = seeded(modelOption, effortOption, fastOption)
    const plan = cache.plan({
      modelId: 'claude-opus-5',
      values: { effort: 'low', fast: false },
    })
    expect(plan.model).toMatchObject({ decision: 'satisfied' })
    expect(plan.staleAfterModelChange).toBe(false)
    expect(plan.values.every((entry) => entry.decision === 'satisfied')).toBe(true)
  })

  it('falls back to the legacy set_model RPC when no model option exists', () => {
    const cache = seeded(effortOption)
    const plan = cache.plan({ modelId: 'claude-opus-5' })
    expect(plan.model).toBeUndefined()
    expect(plan.legacySetModel).toBe(true)
  })

  it('drops everything on invalidate', () => {
    const cache = seeded(modelOption)
    cache.invalidate()
    expect(cache.state).toBeUndefined()
    expect(cache.modelConfigId).toBeUndefined()
  })
})
