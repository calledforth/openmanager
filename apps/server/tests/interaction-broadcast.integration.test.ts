import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeClaudeSdk } from '@agentpack/runtime/testing'
import type { ReplayResponse, SubscriptionScope } from '@openmanager/protocol/node'
import {
  cleanupProtocolHosts,
  collectThreadRecords,
  connectProtocol,
  handshake,
  replay,
  startProtocolHost,
  subscribe,
} from './helpers/protocol-client.js'
import { expectCommand, gatedFirstPrompt } from './helpers/proof-slice.js'

afterEach(async () => {
  vi.restoreAllMocks()
  await cleanupProtocolHosts()
})

describe.each(['permission', 'question', 'plan'] as const)('%s settlement broadcast', (kind) => {
  it.each(['answered', 'timeout', 'tool-cancelled', 'session-closed'] as const)(
    'clears both subscribers on %s and gives late subscribers the current pending set',
    async (settlement) => {
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
      const first = await connectProtocol(host)
      await handshake(first)
      const created = await expectCommand(
        first,
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
      const firstSubscription = await subscribe(first, scope)
      await expectCommand(first, 'turn.send', { ...target, text: 'Ask me' }, 'send')
      await collectThreadRecords(first, firstSubscription, (records) =>
        records.some((record) => record.event.name === 'message.delta'),
      )

      // Capture only the broker deadline; sockets and heartbeats keep real time.
      const timers = vi.spyOn(globalThis, 'setTimeout')
      const child = stub.connections.last
      const providerResponse =
        kind === 'permission'
          ? child.requestPermission({
              sessionId: 'stub-session',
              toolCall: { toolCallId: 'tool-1', title: 'Run tests', kind: 'execute' },
              options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
            })
          : kind === 'question'
            ? child.extMethod('cursor/ask_question', {
                questions: [{ id: 'q1', prompt: 'Which?', options: [{ id: 'a', label: 'A' }] }],
              })
            : child.extMethod('cursor/create_plan', { plan: '# Plan', todos: [] })
      const requested = await collectThreadRecords(first, firstSubscription, (records) =>
        records.some((record) => record.event.name === 'interaction.requested'),
      )
      const event = requested.find((record) => record.event.name === 'interaction.requested')!.event
      if (event.name !== 'interaction.requested') throw new Error('expected interaction request')
      const { interaction, turnId } = event.payload
      expect(interaction.kind).toBe(kind)
      const timeoutMs = (kind === 'plan' ? 30 : 5) * 60 * 1000
      const deadline = timers.mock.calls.find((call) => call[1] === timeoutMs)?.[0]
      timers.mockRestore()
      expect(deadline).toBeTypeOf('function')

      // The second device missed the request event entirely, but still sees it.
      const second = await connectProtocol(host)
      await handshake(second)
      const joined = await replay(second, scope, null)
      expect(threadSnapshot(joined).interactions).toEqual([{ interaction, turnId }])
      expect(threadSnapshot(joined).turns).toContainEqual({
        turnId,
        threadId: target.threadId,
        state: 'waiting',
      })

      if (settlement === 'answered') {
        const outcome =
          kind === 'permission'
            ? { outcome: 'selected', optionId: 'allow' }
            : kind === 'question'
              ? { outcome: 'answered', answers: [{ questionId: 'q1', selectedOptionIds: ['a'] }] }
              : { outcome: 'accepted' }
        await expectCommand(
          second,
          'interaction.respond',
          {
            ...target,
            response: { kind, interactionId: interaction.interactionId, outcome },
          },
          'answer on second device',
        )
      } else if (settlement === 'timeout') {
        // Exercise the real broker's timeout callback without waiting minutes.
        ;(deadline as () => void)()
      } else if (settlement === 'tool-cancelled') {
        await expectCommand(first, 'turn.interrupt', { ...target, turnId }, 'cancel tool')
      } else {
        await child.crash()
      }
      await providerResponse

      const deliveries = await Promise.all([
        collectThreadRecords(first, firstSubscription, (records) =>
          records.some((record) => record.event.name === 'interaction.resolved'),
        ),
        collectThreadRecords(second, joined.payload.subscriptionId, (records) =>
          records.some((record) => record.event.name === 'interaction.resolved'),
        ),
      ])
      const resolutions = deliveries.map((records) =>
        records.filter((record) => record.event.name === 'interaction.resolved'),
      )
      expect(resolutions[0]).toHaveLength(1)
      expect(resolutions[1]).toEqual(resolutions[0])
      expect(resolutions[0]![0]!.event.payload).toMatchObject({
        turnId,
        response: {
          kind,
          interactionId: interaction.interactionId,
          ...(settlement === 'answered'
            ? {}
            : {
                outcome: {
                  outcome: 'cancelled',
                  reason:
                    settlement === 'timeout'
                      ? 'timeout'
                      : settlement === 'tool-cancelled'
                        ? 'tool_cancelled'
                        : 'session_closed',
                },
              }),
        },
      })

      // A fresh third device needs no historical resolve event to hide the dialog.
      const third = await connectProtocol(host)
      await handshake(third)
      expect(threadSnapshot(await replay(third, scope, null)).interactions).toEqual([])
      if (settlement === 'answered' || settlement === 'timeout') stub.release()
    },
  )
})

function threadSnapshot(answer: ReplayResponse) {
  if (answer.payload.mode !== 'snapshot' || !('thread' in answer.payload.snapshot.state)) {
    throw new Error('expected a thread snapshot')
  }
  return answer.payload.snapshot.state
}
