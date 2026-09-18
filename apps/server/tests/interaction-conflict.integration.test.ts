import { afterEach, describe, expect, it } from 'vitest'
import { FakeClaudeSdk } from '@agentpack/runtime/testing'
import type { SubscriptionScope } from '@openmanager/protocol/node'
import {
  cleanupProtocolHosts,
  collectThreadRecords,
  connectProtocol,
  handshake,
  nextResponse,
  startProtocolHost,
  subscribe,
  type ProtocolClient,
} from './helpers/protocol-client.js'
import { expectCommand, gatedFirstPrompt } from './helpers/proof-slice.js'

afterEach(cleanupProtocolHosts)

const rivals = {
  permission: [
    { outcome: 'selected', optionId: 'allow' },
    { outcome: 'selected', optionId: 'deny' },
  ],
  question: [
    { outcome: 'answered', answers: [{ questionId: 'q1', selectedOptionIds: ['a'] }] },
    { outcome: 'answered', answers: [{ questionId: 'q1', selectedOptionIds: ['b'] }] },
  ],
  plan: [{ outcome: 'accepted' }, { outcome: 'rejected', reason: 'Not this way' }],
} as const

describe.each(['permission', 'question', 'plan'] as const)('%s answered by two clients', (kind) => {
  // Whichever device the server hears first wins, so both orders are raced.
  it.each([
    ['first', [0, 1]],
    ['second', [1, 0]],
  ] as const)('lets one answer win when the %s device sends first', async (_, order) => {
    const stub = gatedFirstPrompt({ prefix: 'Waiting', suffix: '' })
    let workspaceRoot = ''
    const host = await startProtocolHost({
      runtimeOptions: {
        connections: stub.connections,
        claudeSdk: new FakeClaudeSdk(),
        health: { schedule: () => ({ cancel() {} }) },
      },
      resolveWorkspace: () => ({ providerId: 'cursor', cwd: workspaceRoot }),
    })
    workspaceRoot = host.workspaceRoot
    const clients = [await connectProtocol(host), await connectProtocol(host)] as const
    for (const client of clients) await handshake(client)
    const created = await expectCommand(
      clients[0],
      'session.create',
      {
        environmentId: host.server.identity.environmentId,
        providerId: 'cursor',
        workspaceId: host.workspaceId,
      },
      'create',
    )
    const target = {
      sessionId: created.payload.session.sessionId,
      threadId: created.payload.thread.threadId,
    }
    const scope: SubscriptionScope = {
      type: 'thread',
      environmentId: host.server.identity.environmentId,
      ...target,
    }
    const subscriptions = [await subscribe(clients[0], scope), await subscribe(clients[1], scope)]
    await expectCommand(clients[0], 'turn.send', { ...target, text: 'Ask me' }, 'send')

    const child = stub.connections.last
    const providerResponse =
      kind === 'permission'
        ? child.requestPermission({
            sessionId: 'stub-session',
            toolCall: { toolCallId: 'tool-1', title: 'Run tests', kind: 'execute' },
            options: [
              { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
              { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
            ],
          })
        : kind === 'question'
          ? child.extMethod('cursor/ask_question', {
              questions: [
                {
                  id: 'q1',
                  prompt: 'Which?',
                  options: [
                    { id: 'a', label: 'A' },
                    { id: 'b', label: 'B' },
                  ],
                },
              ],
            })
          : child.extMethod('cursor/create_plan', { plan: '# Plan', todos: [] })
    const requested = await collectThreadRecords(clients[0], subscriptions[0]!, (records) =>
      records.some((record) => record.event.name === 'interaction.requested'),
    )
    const event = requested.find((record) => record.event.name === 'interaction.requested')!.event
    if (event.name !== 'interaction.requested') throw new Error('expected interaction request')
    const { interactionId } = event.payload.interaction

    // Both devices answer before either has heard back, each with its own
    // command id and a different answer, so the winner is identifiable.
    const respond = (client: ProtocolClient, index: number, requestId?: string) =>
      client.command(
        'interaction.respond',
        {
          ...target,
          commandId: `answer-${index}`,
          response: { kind, interactionId, outcome: rivals[kind][index] },
        },
        requestId,
      )
    const requestIds: string[] = []
    for (const index of order) requestIds[index] = respond(clients[index], index)
    const results = await Promise.all(
      clients.map((client, index) => nextResponse(client, requestIds[index]!)),
    )

    const winner = results.findIndex((result) => result.type === 'response')
    const loser = 1 - winner
    expect(results.map((result) => result.type).sort()).toEqual(['error', 'response'])
    expect(results[loser]).toMatchObject({
      type: 'error',
      requestId: requestIds[loser],
      error: { code: 'conflict', details: { interactionId } },
    })

    // The winner's acknowledgement may have been lost; sending the same
    // command again succeeds, while the loser keeps losing.
    const retry = respond(clients[winner]!, winner, 'retry-winner')
    expect(await nextResponse(clients[winner]!, retry)).toMatchObject({
      type: 'response',
      requestId: retry,
      payload: null,
    })
    const again = respond(clients[loser]!, loser, 'retry-loser')
    expect(await nextResponse(clients[loser]!, again)).toMatchObject({
      type: 'error',
      error: { code: 'conflict' },
    })

    // The provider heard exactly one answer, and it was the winner's.
    expect(await providerResponse).toMatchObject({ outcome: rivals[kind][winner] })

    // Run the turn out so any second settlement would have been delivered.
    stub.release()
    for (const [index, client] of clients.entries()) {
      const records = await collectThreadRecords(client, subscriptions[index]!, (seen) =>
        seen.some((record) => record.event.name === 'turn.completed'),
      )
      const resolutions = records.filter((record) => record.event.name === 'interaction.resolved')
      expect(resolutions).toHaveLength(1)
      expect(resolutions[0]!.event.payload).toMatchObject({
        response: { kind, interactionId, outcome: rivals[kind][winner] },
      })
    }
  })
})
