import { describe, expect, it } from 'vitest'
import { sanitizeProviderCatalogCache } from './provider-catalog-cache'

describe('sanitizeProviderCatalogCache', () => {
  it('restores a catalog with its capabilities and the build that produced it', () => {
    expect(
      sanitizeProviderCatalogCache({
        cursor: {
          agentVersion: '2026.07.23',
          models: {
            currentModelId: 'composer-2.5',
            availableModels: [
              {
                id: 'composer-2.5',
                displayName: 'Composer 2.5',
                description: 'Fast',
                effortLevels: ['low', 'high'],
                supportsFastMode: true,
              },
            ],
          },
        },
      }),
    ).toEqual({
      cursor: {
        agentVersion: '2026.07.23',
        models: {
          currentModelId: 'composer-2.5',
          availableModels: [
            {
              id: 'composer-2.5',
              displayName: 'Composer 2.5',
              description: 'Fast',
              effortLevels: ['low', 'high'],
              supportsFastMode: true,
            },
          ],
        },
      },
    })
  })

  it('drops entries that carry no usable models', () => {
    expect(
      sanitizeProviderCatalogCache({
        cursor: { models: { availableModels: [] } },
        opencode: { models: { availableModels: [{ id: 'x' }] } },
        claude: { models: {} },
      }),
    ).toEqual({})
  })

  it('drops unknown providers and junk the settings file may contain', () => {
    expect(
      sanitizeProviderCatalogCache({
        notAProvider: { models: { availableModels: [{ id: 'a', displayName: 'A' }] } },
        cursor: 'not an object',
      }),
    ).toEqual({})
    expect(sanitizeProviderCatalogCache(null)).toEqual({})
    expect(sanitizeProviderCatalogCache([1, 2, 3])).toEqual({})
  })

  it('treats an empty effort list as no effort control rather than an empty menu', () => {
    const cache = sanitizeProviderCatalogCache({
      cursor: {
        models: {
          availableModels: [
            { id: 'a', displayName: 'A', effortLevels: [] },
            { id: 'b', displayName: 'B', effortLevels: ['low', 42, ''] },
          ],
        },
      },
    })
    expect(cache.cursor?.models.availableModels).toEqual([
      { id: 'a', displayName: 'A' },
      { id: 'b', displayName: 'B', effortLevels: ['low'] },
    ])
  })

  it('ignores a version that is not a string, rather than storing a fake one', () => {
    const cache = sanitizeProviderCatalogCache({
      cursor: {
        agentVersion: 7,
        models: { availableModels: [{ id: 'a', displayName: 'A' }] },
      },
    })
    expect(cache.cursor).toEqual({ models: { availableModels: [{ id: 'a', displayName: 'A' }] } })
  })
})

describe('sanitizeProviderCatalogCache modes', () => {
  it('restores modes alongside models so the mode pill has data on first paint', () => {
    const cache = sanitizeProviderCatalogCache({
      cursor: {
        models: { availableModels: [{ id: 'a', displayName: 'A' }] },
        modes: {
          currentModeId: 'agent',
          availableModes: [
            { id: 'agent', displayName: 'Agent', description: 'Build' },
            { id: 'plan', displayName: 'Plan' },
            { id: 'junk' },
          ],
        },
      },
    })
    expect(cache.cursor?.modes).toEqual({
      currentModeId: 'agent',
      availableModes: [
        { id: 'agent', displayName: 'Agent', description: 'Build' },
        { id: 'plan', displayName: 'Plan' },
      ],
    })
  })

  it('omits modes entirely rather than storing an empty list', () => {
    const cache = sanitizeProviderCatalogCache({
      cursor: {
        models: { availableModels: [{ id: 'a', displayName: 'A' }] },
        modes: { availableModes: [] },
      },
    })
    expect(cache.cursor).not.toHaveProperty('modes')
  })
})
