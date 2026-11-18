import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeConnectionFactory } from '@agentpack/runtime/testing'
import { ArtifactStreamGrantSchema, ProofResponseSchemas } from '@openmanager/protocol/node'
import {
  cleanupProtocolHosts,
  collectThreadRecords,
  connectProtocol,
  handshake,
  nextResponse,
  subscribe,
  type ProtocolHost,
} from './helpers/protocol-client.js'
import { promptSessionId, startStubHost } from './helpers/proof-slice.js'

afterEach(async () => {
  await cleanupProtocolHosts()
})

/** The smallest thing that reads as an MP4: an `ftyp` box, then filler. */
const MP4 = Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]),
  Buffer.from('ftypisom'),
  Buffer.alloc(4),
  Buffer.from('isomiso2'),
  Buffer.from(Array.from({ length: 4000 }, (_, index) => index % 251)),
])

type ToolAnswer = { content: { text: string }[]; isError?: boolean }

/**
 * An ACP agent that, on its prompt, calls the environment's `share_file` over
 * the MCP endpoint it was given, the way Cursor or OpenCode would.
 */
function sharingAgent(path: string, answers: ToolAnswer[]) {
  let endpoint: { url: string; headers: Record<string, string> } | undefined
  const connections: FakeConnectionFactory = new FakeConnectionFactory({
    initialize: async () => ({
      protocolVersion: 1,
      authMethods: [],
      agentCapabilities: { mcpCapabilities: { http: true } },
    }),
    newSession: async (params) => {
      const servers = (params as { mcpServers: { url: string; headers: { name: string; value: string }[] }[] })
        .mcpServers
      const server = servers[0]!
      endpoint = {
        url: server.url,
        headers: Object.fromEntries(server.headers.map((header) => [header.name, header.value])),
      }
      return { sessionId: 'stub-session' }
    },
    prompt: async (params) => {
      const post = async (body: unknown) =>
        (await (
          await fetch(endpoint!.url, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              accept: 'application/json, text/event-stream',
              ...endpoint!.headers,
            },
            body: JSON.stringify(body),
          })
        ).json()) as { result: ToolAnswer }
      await post({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
      })
      const called = await post({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'share_file', arguments: { path } },
      })
      answers.push(called.result)
      await connections.last.sessionUpdate({
        sessionId: promptSessionId(params),
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Here it is.' } },
      })
      return { stopReason: 'end_turn' }
    },
  })
  return connections
}

async function runTurn(host: ProtocolHost) {
  const client = await connectProtocol(host)
  await handshake(client)
  const createId = client.command('session.create', {
    environmentId: host.server.identity.environmentId,
    providerId: 'opencode',
    workspaceId: host.workspaceId,
  })
  const { session, thread } = ProofResponseSchemas['session.create'].parse(
    await nextResponse(client, createId),
  ).payload
  const subscriptionId = await subscribe(client, {
    type: 'thread',
    environmentId: host.server.identity.environmentId,
    sessionId: session.sessionId,
    threadId: thread.threadId,
  })
  const sendId = client.command('turn.send', {
    sessionId: session.sessionId,
    threadId: thread.threadId,
    text: 'record the flow and show me',
  })
  await nextResponse(client, sendId)
  const records = await collectThreadRecords(client, subscriptionId, (seen) =>
    seen.some((record) => record.event.name === 'turn.completed'),
  )
  return { sessionId: session.sessionId, records }
}

const get = (url: string, headers: Record<string, string> = {}) => fetch(url, { headers })

describe('share_file', () => {
  it('puts a video the agent made into its turn and streams it in ranges', async () => {
    const answers: ToolAnswer[] = []
    const host = await startStubHost(sharingAgent('recordings/flow.mp4', answers))
    await mkdir(join(host.workspaceRoot, 'recordings'))
    await writeFile(join(host.workspaceRoot, 'recordings', 'flow.mp4'), MP4)

    const { sessionId, records } = await runTurn(host)
    expect(answers[0]?.isError).toBeFalsy()
    expect(answers[0]?.content[0]?.text).toMatch(/^Shared flow\.mp4 \(video, /)

    const deltas = records
      .filter((record) => record.event.name === 'message.delta')
      .map((record) => record.event.payload as { content: Record<string, unknown> })
    const shared = deltas.find((delta) => delta.content.type === 'artifact')?.content
    expect(shared).toMatchObject({ mimeType: 'video/mp4', name: 'flow.mp4', sizeBytes: MP4.length })
    // The shared file is its own message, before the text that followed it.
    expect(deltas.findIndex((delta) => delta.content.type === 'artifact')).toBeLessThan(
      deltas.findIndex((delta) => delta.content.type === 'text'),
    )
    const artifactId = shared!.artifactId as string
    const auth = { authorization: `Bearer ${host.token}` }
    const base = `${host.server.url}/artifacts/${sessionId}/${artifactId}`

    // The credentialed route reads it whole, or a range of it.
    const whole = await get(base, auth)
    expect(whole.status).toBe(200)
    expect(whole.headers.get('accept-ranges')).toBe('bytes')
    expect(Buffer.from(await whole.arrayBuffer())).toEqual(MP4)

    // A player gets a grant, then reads by range with no header of its own.
    expect((await get(`${base}/stream`)).status).toBe(401)
    const minted = await get(`${base}/stream`, auth)
    expect(minted.status).toBe(200)
    const grant = ArtifactStreamGrantSchema.parse(await minted.json())
    const media = `${host.server.url}${grant.path}`
    const head = await get(media, { range: 'bytes=0-7' })
    expect(head.status).toBe(206)
    expect(head.headers.get('content-range')).toBe(`bytes 0-7/${MP4.length}`)
    expect(head.headers.get('content-type')).toBe('video/mp4')
    expect(Buffer.from(await head.arrayBuffer())).toEqual(MP4.subarray(0, 8))
    const tail = await get(media, { range: 'bytes=-10' })
    expect(Buffer.from(await tail.arrayBuffer())).toEqual(MP4.subarray(MP4.length - 10))
    const open = await get(media, { range: `bytes=${MP4.length - 3}-` })
    expect(open.headers.get('content-range')).toBe(
      `bytes ${MP4.length - 3}-${MP4.length - 1}/${MP4.length}`,
    )
    expect((await get(media, { range: `bytes=${MP4.length}-` })).status).toBe(416)
    expect((await get(media)).status).toBe(200)

    // A guessed grant reads nothing.
    expect((await get(`${host.server.url}/media/guessed`)).status).toBe(404)
  }, 30_000)

  it('refuses a file that is not media, and shares nothing', async () => {
    const answers: ToolAnswer[] = []
    const host = await startStubHost(sharingAgent('secrets.mp4', answers))
    await writeFile(join(host.workspaceRoot, 'secrets.mp4'), '-----BEGIN OPENSSH PRIVATE KEY-----')
    const { records } = await runTurn(host)
    expect(answers[0]?.isError).toBe(true)
    expect(answers[0]?.content[0]?.text).toMatch(/not a video or image/)
    expect(
      records.some(
        (record) =>
          record.event.name === 'message.delta' &&
          (record.event.payload as { content: { type: string } }).content.type === 'artifact',
      ),
    ).toBe(false)
  }, 30_000)

  it('says when there is no such file', async () => {
    const answers: ToolAnswer[] = []
    const host = await startStubHost(sharingAgent('missing.webm', answers))
    await runTurn(host)
    expect(answers[0]).toMatchObject({ isError: true })
    expect(answers[0]?.content[0]?.text).toMatch(/There is no file at .*missing\.webm/)
  }, 30_000)
})
