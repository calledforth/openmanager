import { describe, expect, it } from 'vitest'
import { placeRecord, placeTransient } from '../src/placement'
import { threadScope } from './fixtures'

const at = (sequence: number, epoch = 'e') => ({ scope: threadScope, epoch, sequence })

describe('the durable-record table (§5.2)', () => {
  it.each([
    { name: 'a repeat of the cursor', record: at(5), expected: 'drop' },
    { name: 'older than the cursor', record: at(2), expected: 'drop' },
    { name: 'the next record', record: at(6), expected: 'apply' },
    { name: 'a gap', record: at(8), expected: 'recover' },
    { name: 'another epoch, lower', record: at(1, 'f'), expected: 'recover' },
    { name: 'another epoch, next', record: at(6, 'f'), expected: 'recover' },
  ])('$name: $expected', ({ record, expected }) => {
    expect(placeRecord(at(5), record)).toBe(expected)
  })

  it('applies the first record of a scope that has no cursor yet', () => {
    expect(placeRecord(null, at(42))).toBe('apply')
  })
})

describe('the transient table (§5.2)', () => {
  it.each([
    { name: 'at the cursor', after: at(5), held: false, expected: 'apply' },
    { name: 'at the cursor, held', after: at(5), held: true, expected: 'apply' },
    { name: 'behind the cursor', after: at(4), held: false, expected: 'drop' },
    { name: 'behind the cursor, held', after: at(4), held: true, expected: 'drop' },
    { name: 'ahead of the cursor', after: at(6), held: false, expected: 'recover' },
    { name: 'ahead of the cursor, held', after: at(6), held: true, expected: 'recover' },
    { name: 'another epoch, live', after: at(5, 'f'), held: false, expected: 'recover' },
    { name: 'another epoch, held', after: at(5, 'f'), held: true, expected: 'drop' },
  ])('$name: $expected', ({ after, held, expected }) => {
    expect(placeTransient(at(5), after, held)).toBe(expected)
  })

  it('drops a transient for a scope with no state to place it in', () => {
    expect(placeTransient(null, at(0), false)).toBe('drop')
  })
})
