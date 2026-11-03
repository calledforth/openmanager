import { describe, expect, it } from 'vitest'
import { platformBeside, withDisplayLabels } from './environment-names'

describe('withDisplayLabels', () => {
  it('adds the platform only to names another environment shares', () => {
    const environments = [
      { label: 'Laptop', platform: 'windows' as const },
      { label: 'laptop', platform: 'wsl' as const },
      { label: 'Desktop', platform: 'linux' as const },
    ]
    expect(withDisplayLabels(environments).map(({ label }) => label)).toEqual([
      'Laptop (Windows)',
      'laptop (WSL)',
      'Desktop',
    ])
  })

  it('leaves a shared name alone when the platform is unknown', () => {
    const environments = [{ label: 'Laptop' }, { label: 'Laptop', platform: 'wsl' as const }]
    expect(withDisplayLabels(environments).map(({ label }) => label)).toEqual([
      'Laptop',
      'Laptop (WSL)',
    ])
  })

  it('returns the same list when no name changes', () => {
    const environments = [
      { label: 'Laptop', platform: 'windows' as const },
      { label: 'Desktop', platform: 'wsl' as const },
    ]
    expect(withDisplayLabels(environments)).toBe(environments)
  })
})

describe('platformBeside', () => {
  it('shows the platform unless the name already carries it', () => {
    expect(platformBeside({ label: 'Desktop', platform: 'wsl' })).toBe('WSL')
    expect(platformBeside({ label: 'Laptop (WSL)', platform: 'wsl' })).toBeUndefined()
    expect(platformBeside({ label: 'Laptop' })).toBeUndefined()
  })
})
