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
        {
          id: 'gpt-5.4',
          displayName: 'GPT-5.4',
          configOptions: [
            {
              type: 'select',
              id: 'reasoning',
              name: 'Reasoning',
              category: 'thought_level',
              currentValue: 'low',
              options: [{ value: 'low', name: 'Low' }],
            },
          ],
        },
      ],
    })
  })

  it("keeps each model's settings as a session on it would list them", () => {
    // Shape measured on cursor-agent 2026-09-28 (`claude-opus-5-5`).
    const listing = cursorModelListing({
      models: [
        { value: 'default', name: 'Auto', configOptions: [] },
        {
          value: 'claude-opus-5-5',
          name: 'Claude Opus 5.5',
          configOptions: [
            {
              id: 'context',
              name: 'Context',
              description: 'Context size the model has available.',
              category: 'model_config',
              type: 'select',
              currentValue: '300k',
              options: [
                { value: '300k', name: '300K' },
                { value: '1m', name: '1M' },
              ],
            },
            {
              id: 'effort',
              name: 'Effort',
              category: 'thought_level',
              type: 'select',
              currentValue: 'medium',
              options: [
                { group: 'Levels', name: 'Levels', options: [{ value: 'low', name: 'Low' }] },
                { value: 'medium', name: 'Medium' },
              ],
            },
            { id: 'fast', name: 'Fast', category: 'model_config', type: 'boolean', currentValue: false },
            { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'x', options: [] },
            { id: 'broken', type: 'select', currentValue: 'a', options: [] },
          ],
        },
      ],
    })
    expect(listing.availableModels).toEqual([
      // `[]` is an answer — this model has no settings — and survives.
      { id: 'default', displayName: 'Auto', configOptions: [] },
      {
        id: 'claude-opus-5-5',
        displayName: 'Claude Opus 5.5',
        configOptions: [
          {
            type: 'select',
            id: 'context',
            name: 'Context',
            description: 'Context size the model has available.',
            category: 'model_config',
            currentValue: '300k',
            options: [
              { value: '300k', name: '300K' },
              { value: '1m', name: '1M' },
            ],
          },
          {
            type: 'select',
            id: 'effort',
            name: 'Effort',
            category: 'thought_level',
            currentValue: 'medium',
            // Grouped values are flattened into the one list the composer draws.
            options: [
              { value: 'low', name: 'Low' },
              { value: 'medium', name: 'Medium' },
            ],
          },
          { type: 'boolean', id: 'fast', name: 'Fast', category: 'model_config', currentValue: false },
        ],
      },
    ])
  })

  it('reads the modes from a session, since no extension lists them', () => {
    expect(cursor.models?.catalog).toMatchObject({ via: 'extension', modesFromSession: true })
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
