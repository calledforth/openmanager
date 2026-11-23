import { describe, expect, it } from 'vitest'
import { effortDisplayName, type ComposerControls } from '@openmanager/app-core/logic'

import {
  effortChoicesOf,
  fastOn,
  isSpeedSetting,
  modeChoicesOf,
  picksOf,
} from '../src/composer/controls-view'
import type { SessionConfigOption } from '../src/composer/model'

const SPEED = {
  type: 'select',
  id: 'service_tier',
  name: 'Speed',
  category: 'service_tier',
  currentValue: 'default',
  options: [
    { value: 'default', name: 'Standard' },
    { value: 'priority', name: 'Fast' },
  ],
} as SessionConfigOption
const FAST = { type: 'boolean', id: 'fast_mode', name: 'Fast mode', currentValue: false } as const
const WEB = {
  type: 'select',
  id: 'web_search',
  name: 'Web search',
  currentValue: 'live',
  options: [
    { value: 'disabled', name: 'Off' },
    { value: 'live', name: 'Live' },
  ],
} as SessionConfigOption

const controls = (overrides: Partial<ComposerControls>): ComposerControls =>
  ({
    currentProviderId: 'codex',
    currentProviderName: 'Codex',
    providerModelGroups: [
      { providerId: 'codex', providerName: 'Codex', models: [{ id: 'gpt', name: 'gpt' }] },
    ],
    currentModelId: 'gpt',
    modeOptions: [],
    currentModeId: '',
    effortLevels: [],
    configOptions: [],
    effortConfigId: 'effort',
    currentEffort: '',
    usage: null,
    canChangeSettings: true,
    showModeControl: true,
    ...overrides,
  }) as ComposerControls

describe('the model settings pick', () => {
  it('lights the bolt for fast mode and for a Codex speed faster than Standard', () => {
    expect(isSpeedSetting(SPEED)).toBe(true)
    expect(isSpeedSetting(WEB)).toBe(false)
    expect(fastOn([SPEED, WEB])).toBe(false)
    expect(fastOn([{ ...SPEED, currentValue: 'priority' } as SessionConfigOption])).toBe(true)
    expect(fastOn([FAST])).toBe(false)
    expect(fastOn([{ ...FAST, currentValue: true }])).toBe(true)
  })

  it('names Claude’s bare effort levels as web does, and says Auto with none picked', () => {
    expect(effortDisplayName('xhigh')).toBe('X-High')
    expect(effortDisplayName('high')).toBe('High')
    expect(effortDisplayName('Extra high')).toBe('Extra high')
    const claude = controls({ currentProviderId: 'claude', effortLevels: ['low', 'high'] })
    expect(effortChoicesOf(claude).map((choice) => choice.name)).toEqual(['Low', 'High'])
    expect(picksOf(claude, null).effort).toEqual({ id: '', label: 'Auto' })
    expect(picksOf({ ...claude, currentEffort: 'high' }, null).effort).toEqual({
      id: 'high',
      label: 'High',
    })
  })

  it('reads the bolt from the session settings, and leaves the model and mode selectors out', () => {
    const codex = controls({
      configOptions: [{ ...SPEED, currentValue: 'priority' } as SessionConfigOption, WEB],
    })
    expect(picksOf(codex, null).fast).toBe(true)
  })
})

describe('the mode pick', () => {
  it('keeps a mode a Codex policy rules out listed, saying why', () => {
    const view = modeChoicesOf(
      controls({
        modeOptions: [
          { id: 'auto', name: 'Auto' },
          { id: 'full-access', name: 'Full access', disabledReason: 'Not allowed by a policy' },
        ],
        currentModeId: 'auto',
      }),
    )
    expect(view.choices.map((choice) => [choice.id, choice.disabledReason])).toEqual([
      ['auto', undefined],
      ['full-access', 'Not allowed by a policy'],
    ])
  })

  it('keeps the reason through Build / Plan', () => {
    const view = modeChoicesOf(
      controls({
        modeOptions: [
          { id: 'agent', name: 'Agent' },
          { id: 'plan', name: 'Plan', disabledReason: 'Off here' },
        ],
        currentModeId: 'agent',
      }),
    )
    expect(view.choices).toEqual([
      { id: 'agent', name: 'Build' },
      { id: 'plan', name: 'Plan', disabledReason: 'Off here' },
    ])
  })
})
