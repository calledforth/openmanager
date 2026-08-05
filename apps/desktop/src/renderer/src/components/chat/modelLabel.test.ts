import { describe, expect, it } from 'vitest'
import { modelHint, modelLabel } from './modelLabel'

// Verbatim from `claude 2.1.220`'s initialize response.
const OPUS = 'Opus 5 · Best for everyday, complex tasks · ~2× usage vs Sonnet'
const DEFAULT_ROW = 'Sonnet 5 · Efficient for routine tasks'
const HAIKU = 'Haiku 4.5 · Fastest for quick answers'

describe('modelLabel', () => {
  it('lifts the version out of the description', () => {
    expect(modelLabel('Opus', OPUS)).toBe('Opus 5')
    expect(modelLabel('Haiku', HAIKU)).toBe('Haiku 4.5')
    expect(modelLabel('Fable', 'Fable 5 · Most capable')).toBe('Fable 5')
  })

  it('refuses to rename a row after the model it resolves to', () => {
    // The bug a blind split would introduce: the `default` row's description
    // describes Sonnet, so splitting relabels it "Sonnet 5" — wrong, and it
    // would silently change whenever the alias is repointed.
    expect(modelLabel('Default (recommended)', DEFAULT_ROW)).toBe('Default (recommended)')
  })

  it('falls back to the name it was given', () => {
    expect(modelLabel('Opus', undefined)).toBe('Opus')
    expect(modelLabel('Opus', '')).toBe('Opus')
    expect(modelLabel('Composer 2.5', 'A fast in-house model')).toBe('Composer 2.5')
  })

  it('leaves an already-versioned name alone', () => {
    expect(modelLabel('Opus 5', 'Opus 5 · Best for everyday tasks')).toBe('Opus 5')
  })
})

describe('modelHint', () => {
  it('drops the version it already promoted', () => {
    expect(modelHint('Opus', OPUS)).toBe('Best for everyday, complex tasks · ~2× usage vs Sonnet')
    expect(modelHint('Haiku', HAIKU)).toBe('Fastest for quick answers')
  })

  it('keeps the whole description when nothing was promoted', () => {
    // The `default` row's version names another model, so it stays in the
    // hint — that is exactly what the user needs to know about that row.
    expect(modelHint('Default (recommended)', DEFAULT_ROW)).toBe(DEFAULT_ROW)
  })

  it('is absent when there is nothing left to say', () => {
    expect(modelHint('Opus', 'Opus 5')).toBeUndefined()
    expect(modelHint('Opus', undefined)).toBeUndefined()
  })
})
