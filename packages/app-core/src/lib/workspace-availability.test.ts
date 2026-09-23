import { describe, expect, it } from 'vitest'
import { describeUnavailableWorkspace } from './workspace-availability'

describe('describeUnavailableWorkspace', () => {
  it('names permission trouble separately from a folder that is gone', () => {
    const missing = describeUnavailableWorkspace('missing')
    const inaccessible = describeUnavailableWorkspace('inaccessible')
    expect(missing.badge).toBe('MISSING')
    expect(missing.reason).toMatch(/missing or was moved/)
    expect(inaccessible.badge).toBe('NO ACCESS')
    expect(inaccessible.reason).toMatch(/^Permission denied/)
    expect(inaccessible.fix).not.toBe(missing.fix)
  })

  it('reads an environment that only sent exists=false as missing', () => {
    expect(describeUnavailableWorkspace(undefined)).toEqual(describeUnavailableWorkspace('missing'))
  })
})
