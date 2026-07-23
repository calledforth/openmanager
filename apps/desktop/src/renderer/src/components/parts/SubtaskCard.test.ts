import { describe, expect, it } from 'vitest'
import { subtaskVerb } from './SubtaskCard'

describe('subtaskVerb', () => {
  it.each([
    ['running', 'Running subagent'],
    ['completed', 'Ran subagent'],
    ['failed', 'Subagent failed'],
    ['cancelled', 'Subagent cancelled'],
    ['interrupted', 'Subagent interrupted'],
    ['unknown', 'Subagent status unknown'],
  ])('labels %s status explicitly', (status, label) => {
    expect(subtaskVerb(status)).toBe(label)
  })
})
