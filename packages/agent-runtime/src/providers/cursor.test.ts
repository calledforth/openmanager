import { describe, expect, it } from 'vitest'
import { cursor, cursorModelListing } from './cursor.js'

describe('Cursor model listing', () => {
  it('reads the ids a session accepts and the names Cursor gives them', () => {
    expect(
      cursorModelListing({
        models: [
          { value: 'composer-2.5', name: 'Composer 2.5' },
          {
            value: ' gpt-5.4 ',
            name: ' GPT-5.4 ',
            configOptions: [
              {
                id: 'reasoning',
                name: 'Reasoning',
                category: 'thought_level',
                type: 'select',
                currentValue: 'medium',
                options: [{ value: 'low', name: 'Low' }],
              },
            ],
          },
        ],
      }),
    ).toEqual({
      availableModels: [
        { id: 'composer-2.5', displayName: 'Composer 2.5' },
        { id: 'gpt-5.4', displayName: 'GPT-5.4' },
      ],
    })
  })

  it('drops rows it cannot offer and lists a model once', () => {
    expect(
      cursorModelListing({
        models: [
          { value: 'composer-2.5', name: 'Composer 2.5' },
          { value: 'composer-2.5', name: 'Composer 2.5 again' },
          { value: '', name: 'No id' },
          { value: 'no-name' },
          { name: 'No value' },
          null,
          'composer-2.5',
        ],
      }),
    ).toEqual({ availableModels: [{ id: 'composer-2.5', displayName: 'Composer 2.5' }] })
  })

  it('answers empty for anything that is not a listing', () => {
    for (const response of [undefined, null, {}, { models: 'composer-2.5' }, { models: [] }, 'x']) {
      expect(cursorModelListing(response)).toEqual({})
    }
  })

  it('is how the Cursor provider says its catalog is read', () => {
    expect(cursor.models?.catalog).toMatchObject({
      via: 'extension',
      method: 'cursor/list_available_models',
      sessionFallback: true,
    })
  })
})
