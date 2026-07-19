import type * as acp from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'vitest'
import { parseAcpFormElicitation } from './elicitation.js'

const formRequest: acp.CreateElicitationRequest = {
  sessionId: 'session-1',
  mode: 'form',
  message: 'Configure the project',
  requestedSchema: {
    type: 'object',
    properties: {
      strategy: {
        type: 'string',
        title: 'Strategy',
        oneOf: [
          { const: 'safe', title: 'Safe' },
          { const: 'fast', title: 'Fast' },
        ],
      },
      tags: {
        type: 'array',
        title: 'Tags',
        minItems: 1,
        maxItems: 2,
        items: {
          anyOf: [
            { const: 'api', title: 'API' },
            { const: 'ui', title: 'UI' },
          ],
        },
      },
      name: {
        type: 'string',
        title: 'Project name',
        minLength: 2,
        pattern: '^[a-z]+$',
      },
      port: {
        type: 'integer',
        title: 'Port',
        minimum: 1024,
        maximum: 65535,
      },
      ratio: {
        type: 'number',
        title: 'Ratio',
        minimum: 0,
        maximum: 1,
      },
      logging: {
        type: 'boolean',
        title: 'Enable logging',
      },
    },
    required: ['strategy', 'tags', 'name', 'port', 'ratio', 'logging'],
  },
}

describe('ACP form elicitation adapter', () => {
  it('maps all supported field types to canonical questions and typed ACP content', () => {
    const adapter = parseAcpFormElicitation(formRequest)

    expect(adapter).toMatchObject({
      title: 'Configure the project',
      questions: [
        {
          questionId: 'strategy',
          prompt: 'Strategy',
          options: [
            { optionId: 'safe', label: 'Safe' },
            { optionId: 'fast', label: 'Fast' },
          ],
        },
        {
          questionId: 'tags',
          options: [
            { optionId: 'api', label: 'API' },
            { optionId: 'ui', label: 'UI' },
          ],
          allowMultiple: true,
        },
        { questionId: 'name', options: [], allowFreeText: true },
        { questionId: 'port', options: [], allowFreeText: true },
        { questionId: 'ratio', options: [], allowFreeText: true },
        {
          questionId: 'logging',
          options: [
            { optionId: 'true', label: 'True' },
            { optionId: 'false', label: 'False' },
          ],
        },
      ],
    })

    expect(
      adapter?.respond({
        outcome: 'answered',
        answers: [
          { questionId: 'strategy', selectedOptionIds: ['safe'] },
          { questionId: 'tags', selectedOptionIds: ['api', 'ui'] },
          { questionId: 'name', text: 'demo' },
          { questionId: 'port', text: '3000' },
          { questionId: 'ratio', text: '0.5' },
          { questionId: 'logging', selectedOptionIds: ['true'] },
        ],
      }),
    ).toEqual({
      action: 'accept',
      content: {
        strategy: 'safe',
        tags: ['api', 'ui'],
        name: 'demo',
        port: 3000,
        ratio: 0.5,
        logging: true,
      },
    })
  })

  it('maps canonical cancellation to ACP cancellation', () => {
    const adapter = parseAcpFormElicitation(formRequest)

    expect(adapter?.respond({ outcome: 'cancelled', reason: 'user' })).toEqual({
      action: 'cancel',
    })
  })

  it('validates required fields, options, and numeric constraints before settling', () => {
    const adapter = parseAcpFormElicitation(formRequest)

    expect(() =>
      adapter?.respond({
        outcome: 'answered',
        answers: [{ questionId: 'strategy', selectedOptionIds: ['unknown'] }],
      }),
    ).toThrow('Invalid option for question strategy')

    expect(() =>
      adapter?.respond({
        outcome: 'answered',
        answers: [
          { questionId: 'strategy', selectedOptionIds: ['safe'] },
          { questionId: 'tags', selectedOptionIds: ['api'] },
          { questionId: 'name', text: 'demo' },
          { questionId: 'port', text: '80' },
          { questionId: 'ratio', text: '0.5' },
          { questionId: 'logging', selectedOptionIds: ['true'] },
        ],
      }),
    ).toThrow('Question port must be at least 1024')
  })

  it('does not adapt URL, empty, or unsupported future forms', () => {
    expect(
      parseAcpFormElicitation({
        sessionId: 'session-1',
        mode: 'url',
        message: 'Authenticate',
        elicitationId: 'auth-1',
        url: 'https://example.com/auth',
      }),
    ).toBeUndefined()
    expect(
      parseAcpFormElicitation({
        sessionId: 'session-1',
        mode: 'form',
        message: 'Nothing',
        requestedSchema: { type: 'object', properties: {} },
      }),
    ).toBeUndefined()
    expect(
      parseAcpFormElicitation({
        sessionId: 'session-1',
        mode: 'form',
        message: 'Future',
        requestedSchema: {
          type: 'object',
          properties: { value: { type: 'object' } },
        },
      }),
    ).toBeUndefined()
  })
})
