import { afterEach, describe, expect, it } from 'vitest'
import { FakeClaudeSdk, FakeConnectionFactory } from '@agentpack/runtime/testing'
import { ProofEventSchemas, ProofResponseSchemas } from '@openmanager/protocol/node'
import { TitleGenerationError, type TitleGenerator } from '../src/session-titles/generator.js'
import type { GeneratedTitle, TitlePromptInput } from '../src/session-titles/prompts.js'
import {
  cleanupProtocolHosts,
  collectThreadRecords,
  connectProtocol,
  handshake,
  nextResponse,
  subscribe,
  startProtocolHost,
  type ProtocolClient,
} from './helpers/protocol-client.js'

afterEach(async () => {
  await cleanupProtocolHosts()
})

type Call = {
  input: TitlePromptInput
  signal: AbortSignal | undefined
  answer: (title: GeneratedTitle) => void
  fail: () => void
}

/** A title model the test answers by hand, one call at a time. */
function scriptedTitles() {
  const calls: Call[] = []
  const waiters: (() => void)[] = []
  const generator: TitleGenerator = {
    generate: (input, signal) =>
      new Promise((resolve, reject) => {
        // Like the real runners: a stopped pass ends at once, whatever the model does.
        signal?.addEventListener(
          'abort',
          () => reject(new TitleGenerationError('aborted', 'The title was no longer needed.')),
          { once: true },
        )
        calls.push({
          input,
          signal,
          answer: resolve,
          fail: () => reject(new TitleGenerationError('failed', 'The model could not answer.')),
        })
        waiters.splice(0).forEach((wake) => wake())
      }),
  }
  const call = async (index: number): Promise<Call> => {
    const deadline = Date.now() + 10_000
    while (!calls[index]) {
      if (Date.now() > deadline) throw new Error(`title call ${index} never came`)
      await new Promise<void>((resolve) => {
        waiters.push(resolve)
        setTimeout(resolve, 50)
      })
    }
    return calls[index]!
  }
  return { generator, calls, call }
}

/** An OpenCode fake whose every prompt answers with `reply`, naming its
 * session `agentTitle` first when one is given. */
function replyingAgent(reply: string, agentTitle?: string) {
  const connections: FakeConnectionFactory = new FakeConnectionFactory({
    initialize: async () => ({ protocolVersion: 1, authMethods: [] }),
    newSession: async () => ({ sessionId: 'stub-session' }),
    prompt: async () => {
      if (agentTitle) {
        await connections.last.sessionUpdate({
          sessionId: 'stub-session',
          update: { sessionUpdate: 'session_info_update', title: agentTitle },
        })
      }
      await connections.last.sessionUpdate({
        sessionId: 'stub-session',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply } },
      })
      return { stopReason: 'end_turn' }
    },
  })
  return connections
}

async function startHost(
  titles: TitleGenerator,
  reply = 'The websocket retry backoff is fixed.',
  agentTitle?: string,
) {
  const host = await startProtocolHost({
    titleGenerator: titles,
    runtimeOptions: {
      connections: replyingAgent(reply, agentTitle),
      claudeSdk: new FakeClaudeSdk(),
      health: { schedule: () => ({ cancel() {} }) },
    },
  })
  const client = await connectProtocol(host)
  await handshake(client)
  const environment = await subscribe(client, {
    type: 'environment',
    environmentId: host.server.identity.environmentId,
  })
  return { host, client, environment }
}

async function createSession(
  client: ProtocolClient,
  host: Awaited<ReturnType<typeof startProtocolHost>>,
) {
  const id = client.command('session.create', {
    environmentId: host.server.identity.environmentId,
    providerId: 'opencode',
    workspaceId: host.workspaceId,
  })
  return ProofResponseSchemas['session.create'].parse(await nextResponse(client, id)).payload
}

async function send(client: ProtocolClient, sessionId: string, threadId: string, text: string) {
  const id = client.command('turn.send', { sessionId, threadId, text })
  return ProofResponseSchemas['turn.send'].parse(await nextResponse(client, id)).payload
}

/** Title changes the environment announced, in order, until `until` holds. */
async function titleUpdates(
  client: ProtocolClient,
  subscriptionId: string,
  until: (titles: { title?: string | null; titleSource?: string; status?: string }[]) => boolean,
) {
  const updates = (records: Parameters<Parameters<typeof collectThreadRecords>[2]>[0]) =>
    records
      .filter((record) => record.event.name === 'session.updated')
      .map((record) => ProofEventSchemas['session.updated'].parse(record.event).payload)
  return updates(
    await collectThreadRecords(client, subscriptionId, (records) => until(updates(records))),
  )
}

async function listedSession(client: ProtocolClient, sessionId: string) {
  const id = client.command('session.list', {})
  const { sessions } = ProofResponseSchemas['session.list'].parse(
    await nextResponse(client, id),
  ).payload
  return sessions.find((session) => session.sessionId === sessionId)
}

describe('generated session titles', () => {
  it('names a session from its first prompt and keeps the name in SQLite', async () => {
    const titles = scriptedTitles()
    const { host, client, environment } = await startHost(titles.generator)
    const { session, thread } = await createSession(client, host)
    await send(
      client,
      session.sessionId,
      thread.threadId,
      'fix the websocket reconnect loop please',
    )

    const first = await titles.call(0)
    expect(first.input).toEqual({ message: 'fix the websocket reconnect loop please' })
    first.answer({ title: 'Fix Websocket Reconnect Loop', needsRefinement: false })

    const updates = await titleUpdates(client, environment, (all) =>
      all.some((update) => update.titleSource === 'generated'),
    )
    // The prompt names the session at once; the model's name replaces it.
    expect(updates.filter((update) => update.title !== undefined)).toEqual([
      expect.objectContaining({
        title: 'fix the websocket reconnect loop please',
        titleSource: 'fallback',
      }),
      expect.objectContaining({ title: 'Fix Websocket Reconnect Loop', titleSource: 'generated' }),
    ])
    expect(await listedSession(client, session.sessionId)).toMatchObject({
      title: 'Fix Websocket Reconnect Loop',
      titleSource: 'generated',
    })

    // Later prompts do not rename the session. A pass would have asked the
    // model before `turn.send` answered.
    await send(client, session.sessionId, thread.threadId, 'now add a test')
    expect(titles.calls).toHaveLength(1)
  })

  it('refines a vague first title once the first turn has answered', async () => {
    const titles = scriptedTitles()
    const { host, client, environment } = await startHost(titles.generator)
    const { session, thread } = await createSession(client, host)
    await send(client, session.sessionId, thread.threadId, 'fix this')
    // The first turn finishes before the first title comes back.
    await titleUpdates(client, environment, (all) => all.some((u) => u.status === 'idle'))
    ;(await titles.call(0)).answer({ title: 'Fix Unspecified Issue', needsRefinement: true })

    const refine = await titles.call(1)
    expect(refine.input.previousTitle).toBe('Fix Unspecified Issue')
    expect(refine.input.message).toContain('USER:\nfix this')
    expect(refine.input.message).toContain('ASSISTANT:\nThe websocket retry backoff is fixed.')
    refine.answer({ title: 'Fix Websocket Retry Backoff', needsRefinement: false })

    await titleUpdates(client, environment, (all) =>
      all.some((u) => u.title === 'Fix Websocket Retry Backoff'),
    )
    expect(await listedSession(client, session.sessionId)).toMatchObject({
      title: 'Fix Websocket Retry Backoff',
      titleSource: 'generated',
    })
  })

  it('replaces the name the agent gave its session, even one given meanwhile', async () => {
    const titles = scriptedTitles()
    const { host, client, environment } = await startHost(
      titles.generator,
      'Done.',
      'Reconnect help',
    )
    const { session, thread } = await createSession(client, host)
    await send(client, session.sessionId, thread.threadId, 'fix the reconnect loop')
    const first = await titles.call(0)
    // The agent names its session while the title is being written.
    await titleUpdates(client, environment, (all) => all.some((u) => u.titleSource === 'provider'))
    first.answer({ title: 'Fix Reconnect Loop', needsRefinement: false })
    await titleUpdates(client, environment, (all) => all.some((u) => u.titleSource === 'generated'))

    // And naming it again on the next turn does not undo the generated title.
    await send(client, session.sessionId, thread.threadId, 'and add a test')
    await titleUpdates(client, environment, (all) => all.some((u) => u.status === 'idle'))
    expect(await listedSession(client, session.sessionId)).toMatchObject({
      title: 'Fix Reconnect Loop',
      titleSource: 'generated',
    })
  })

  it('drops a title that arrives after the user renamed the session', async () => {
    const titles = scriptedTitles()
    const { host, client } = await startHost(titles.generator)
    const { session, thread } = await createSession(client, host)
    await send(client, session.sessionId, thread.threadId, 'fix the reconnect loop')
    const first = await titles.call(0)

    const renameId = client.command('session.rename', {
      sessionId: session.sessionId,
      title: 'My name for it',
    })
    await nextResponse(client, renameId)
    first.answer({ title: 'Fix Reconnect Loop', needsRefinement: false })
    // Let the answer settle before checking nothing was saved.
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(await listedSession(client, session.sessionId)).toMatchObject({
      title: 'My name for it',
      titleSource: 'user',
    })
  })

  it('stops the pass a rename made useless, and a regenerate a newer one replaced', async () => {
    const titles = scriptedTitles()
    const { host, client, environment } = await startHost(titles.generator)
    const { session, thread } = await createSession(client, host)
    await send(client, session.sessionId, thread.threadId, 'fix the reconnect loop')
    const first = await titles.call(0)
    const renameId = client.command('session.rename', {
      sessionId: session.sessionId,
      title: 'Mine',
    })
    await nextResponse(client, renameId)
    expect(first.signal?.aborted).toBe(true)
    await titleUpdates(client, environment, (all) => all.some((u) => u.status === 'idle'))

    const olderId = client.command('session.title.regenerate', { sessionId: session.sessionId })
    const older = await titles.call(1)
    const newerId = client.command('session.title.regenerate', { sessionId: session.sessionId })
    const newer = await titles.call(2)
    expect(older.signal?.aborted).toBe(true)
    // The older CLI answers anyway; the answer is not saved or reported as done.
    older.answer({ title: 'Stale', needsRefinement: false })
    expect(await nextResponse(client, olderId)).toMatchObject({
      type: 'error',
      error: { code: 'conflict' },
    })
    newer.answer({ title: 'Fix Reconnect Loop', needsRefinement: false })
    expect(await nextResponse(client, newerId)).toMatchObject({
      type: 'response',
      payload: { session: { title: 'Fix Reconnect Loop' } },
    })
    expect(await listedSession(client, session.sessionId)).toMatchObject({
      title: 'Fix Reconnect Loop',
      titleSource: 'generated',
    })
  })

  it('stops title passes when the server closes', async () => {
    const titles = scriptedTitles()
    const { host, client } = await startHost(titles.generator)
    const { session, thread } = await createSession(client, host)
    await send(client, session.sessionId, thread.threadId, 'fix the reconnect loop')
    const first = await titles.call(0)
    await host.server.close()
    expect(first.signal?.aborted).toBe(true)
  })

  it('regenerates on request from the conversation, replacing a rename', async () => {
    const titles = scriptedTitles()
    const { host, client, environment } = await startHost(titles.generator)
    const { session, thread } = await createSession(client, host)
    await send(client, session.sessionId, thread.threadId, 'fix the reconnect loop')
    ;(await titles.call(0)).fail()
    await titleUpdates(client, environment, (all) => all.some((u) => u.status === 'idle'))
    const renameId = client.command('session.rename', {
      sessionId: session.sessionId,
      title: 'scratch',
    })
    await nextResponse(client, renameId)

    const regenerateId = client.command('session.title.regenerate', {
      sessionId: session.sessionId,
    })
    const regenerate = await titles.call(1)
    expect(regenerate.input.previousTitle).toBe('scratch')
    expect(regenerate.input.message).toContain('USER:\nfix the reconnect loop')
    expect(regenerate.input.message).toContain('ASSISTANT:\n')
    regenerate.answer({ title: 'Fix Reconnect Loop', needsRefinement: false })

    const response = ProofResponseSchemas['session.title.regenerate'].parse(
      await nextResponse(client, regenerateId),
    )
    expect(response.payload.session).toMatchObject({
      sessionId: session.sessionId,
      title: 'Fix Reconnect Loop',
    })
    expect(await listedSession(client, session.sessionId)).toMatchObject({
      title: 'Fix Reconnect Loop',
      titleSource: 'generated',
    })
  })

  it('answers unavailable when the title model fails on request', async () => {
    const titles = scriptedTitles()
    const { host, client, environment } = await startHost(titles.generator)
    const { session, thread } = await createSession(client, host)
    await send(client, session.sessionId, thread.threadId, 'fix the reconnect loop')
    ;(await titles.call(0)).answer({ title: 'Fix Reconnect Loop', needsRefinement: false })
    await titleUpdates(client, environment, (all) => all.some((u) => u.status === 'idle'))

    const regenerateId = client.command('session.title.regenerate', {
      sessionId: session.sessionId,
    })
    ;(await titles.call(1)).fail()
    expect(await nextResponse(client, regenerateId)).toMatchObject({
      type: 'error',
      error: { code: 'unavailable', message: 'The model could not answer.' },
    })
    expect(await listedSession(client, session.sessionId)).toMatchObject({
      title: 'Fix Reconnect Loop',
    })
  })

  it('refuses to regenerate when the environment has no title model', async () => {
    const host = await startProtocolHost({
      runtimeOptions: {
        connections: replyingAgent('ok'),
        claudeSdk: new FakeClaudeSdk(),
        health: { schedule: () => ({ cancel() {} }) },
      },
    })
    const client = await connectProtocol(host)
    await handshake(client)
    const { session } = await createSession(client, host)
    const id = client.command('session.title.regenerate', { sessionId: session.sessionId })
    expect(await nextResponse(client, id)).toMatchObject({
      type: 'error',
      error: { code: 'unavailable' },
    })
  })
})
