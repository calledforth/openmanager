/**
 * Tool output (F6). A running tool's text travels in events; a settled tool's
 * stays on the environment and is read when a row is opened. Every scenario
 * asserts rule 6, and those about a chat's size read what crossed the wire.
 */
import { describe, expect } from 'vitest'
import type { ProviderOp } from './child-protocol.ts'
import { expectConverges } from './evidence.ts'
import { until, type Rig, type TestClient } from './harness.ts'
import { scenario } from './scenario.ts'
import { createSession, startTurn, thread, untilThread, type Target } from './steps.ts'

const QUIET = { quiet: true } as const
const text = (value: string) => [{ type: 'content', content: { type: 'text', text: value } }]
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

type Update = Omit<Extract<ProviderOp, { op: 'updateTool' }>, 'op' | 'sessionId' | 'toolCallId'>

const open = (rig: Rig, target: Target, toolCallId: string, title = 'bash', kind = 'execute') =>
  rig.provider({ op: 'openTool', sessionId: target.sessionId, toolCallId, title, kind })

const update = (rig: Rig, target: Target, toolCallId: string, fields: Update) =>
  rig.provider({ op: 'updateTool', sessionId: target.sessionId, toolCallId, ...fields })

const toolOf = (client: TestClient, target: Target, index = 0) =>
  thread(client, target)?.tools[index]

/** Read a tool's output as a row does: over the HTTP route, by a client that holds the chat. */
async function readOutput(rig: Rig, target: Target, toolCallId: string) {
  const reader = await rig.connect('reader', { link: 'direct' })
  try {
    await until(() => reader.client.getState().connection.phase === 'connected', 'reader')
    return await reader.client.fetchToolOutput!({ sessionId: target.sessionId, toolCallId })
  } finally {
    reader.dispose()
  }
}

describe('tool output', () => {
  scenario('T1 running text written while away is replayed (guard)', {}, async (rig) => {
    const a = await rig.connect('A')
    const target = await createSession(rig, a, QUIET)
    await startTurn(a, target)
    await open(rig, target, 'tool-t1')
    await update(rig, target, 'tool-t1', { status: 'in_progress', content: text('one\n') })
    await untilThread(a, target, (state) => state.tools[0]?.output === 'one\n', 'A to hold it')
    rig.proxy.down()
    rig.proxy.cut()
    await update(rig, target, 'tool-t1', { status: 'in_progress', content: text('one\ntwo\n') })
    await rig.waitQuiet()
    rig.proxy.up()
    await untilThread(a, target, (state) => state.tools[0]?.output === 'one\ntwo\n', 'the replay')
    await expectConverges('T1', rig, a)
  })

  scenario('T2 a tool settles past retention: the snapshot says so (A8, A10)', {}, async (rig) => {
    const a = await rig.connect('A')
    const target = await createSession(rig, a, QUIET)
    await startTurn(a, target)
    await open(rig, target, 'tool-t2')
    await update(rig, target, 'tool-t2', { status: 'in_progress', content: text('partial') })
    await untilThread(a, target, (state) => state.tools[0]?.output === 'partial', 'A to hold it')
    const held = toolOf(a, target)!
    rig.proxy.down()
    rig.proxy.cut()
    await update(rig, target, 'tool-t2', { status: 'failed', rawOutput: { error: 'it broke' } })
    await rig.waitQuiet()
    await rig.server.call({ op: 'raiseReplayFloor', threadId: target.threadId })
    rig.proxy.up()
    await untilThread(a, target, (state) => state.tools[0]?.status === 'failed', 'the snapshot')
    expect(toolOf(a, target)).toMatchObject({ status: 'failed', outputBytes: 8 })
    expect(toolOf(a, target)?.output).toBeUndefined()
    await expectConverges('T2', rig, a)
    expect(await readOutput(rig, target, held.toolCallId)).toBe('it broke')
  })

  scenario('T3 a shorter final result replaces long progress (A12, A14)', {}, async (rig) => {
    const a = await rig.connect('A')
    const target = await createSession(rig, a, QUIET)
    await startTurn(a, target)
    await open(rig, target, 'tool-t3')
    await update(rig, target, 'tool-t3', {
      status: 'in_progress',
      content: text('long progress output '.repeat(40)),
    })
    await untilThread(a, target, (state) => (state.tools[0]?.output?.length ?? 0) > 0, 'running')
    rig.proxy.down()
    rig.proxy.cut()
    await update(rig, target, 'tool-t3', { status: 'completed', rawOutput: 'short' })
    await rig.waitQuiet()
    rig.proxy.up()
    await untilThread(a, target, (state) => state.tools[0]?.status === 'completed', 'the catch-up')
    expect(toolOf(a, target)).toMatchObject({ outputBytes: 5 })
    await expectConverges('T3', rig, a)
    expect(await readOutput(rig, target, toolOf(a, target)!.toolCallId)).toBe('short')
  })

  scenario(
    'T4 a restart closes a running tool by event and keeps its text (A4)',
    {},
    async (rig) => {
      const a = await rig.connect('A')
      const target = await createSession(rig, a, QUIET)
      await startTurn(a, target)
      await open(rig, target, 'tool-t4')
      await update(rig, target, 'tool-t4', {
        status: 'in_progress',
        content: text('written so far'),
      })
      await untilThread(
        a,
        target,
        (state) => state.tools[0]?.output === 'written so far',
        'running',
      )
      const before = a.connects
      await rig.crash()
      await until(() => a.connects > before, 'A to reconnect', 20_000)
      await until(() => !a.busy(), 'A to finish its reconnect')
      await untilThread(a, target, (state) => state.tools[0]?.status === 'cancelled', 'the close')
      const tool = toolOf(a, target)!
      expect(tool.outputBytes).toBe(14)
      expect(tool.finishedAt).toBeDefined()
      expect(tool.output).toBeUndefined()
      await expectConverges('T4', rig, a)
      expect(await readOutput(rig, target, tool.toolCallId)).toBe('written so far')
    },
  )

  scenario(
    'T5 a snapshot mid-stream, then deltas: nothing repeats or goes missing',
    {},
    async (rig) => {
      const a = await rig.connect('A')
      const target = await createSession(rig, a, QUIET)
      await startTurn(a, target)
      await open(rig, target, 'tool-t5')
      await update(rig, target, 'tool-t5', { status: 'in_progress', content: text('a') })
      await untilThread(a, target, (state) => state.tools[0]?.output === 'a', 'running')
      rig.proxy.down()
      rig.proxy.cut()
      await update(rig, target, 'tool-t5', { status: 'in_progress', content: text('ab') })
      await rig.waitQuiet()
      await rig.server.call({ op: 'raiseReplayFloor', threadId: target.threadId })
      rig.proxy.up()
      await untilThread(a, target, (state) => state.tools[0]?.output === 'ab', 'the snapshot')
      await update(rig, target, 'tool-t5', { status: 'in_progress', content: text('abc') })
      await untilThread(a, target, (state) => state.tools[0]?.output === 'abc', 'the next delta')
      await expectConverges('T5', rig, a)
      await update(rig, target, 'tool-t5', { status: 'completed' })
      await untilThread(a, target, (state) => state.tools[0]?.status === 'completed', 'the settle')
      expect(toolOf(a, target)?.outputBytes).toBe(3)
      expect(await readOutput(rig, target, toolOf(a, target)!.toolCallId)).toBe('abc')
    },
  )

  scenario('T6 a burst of deltas folds to the same text in fewer events', {}, async (rig) => {
    const a = await rig.connect('A')
    const target = await createSession(rig, a, QUIET)
    await startTurn(a, target)
    await open(rig, target, 'tool-t6')
    const lines = 2_000
    const mark = rig.proxy.frames.length
    await rig.provider({
      op: 'streamToolLines',
      sessionId: target.sessionId,
      toolCallId: 'tool-t6',
      lines,
    })
    await untilThread(
      a,
      target,
      (state) => state.tools[0]?.output?.split('\n').length === lines + 1,
      'every line',
      30_000,
    )
    const updates = rig.proxy.frames
      .slice(mark)
      .filter((frame) => JSON.stringify(frame.json ?? '').includes('tool.updated')).length
    expect(updates).toBeLessThan(lines / 2)
    await expectConverges('T6', rig, a)
  })

  scenario(
    "T7 a refusal is the tool's outcome at once, and survives a restart",
    {},
    async (rig) => {
      const a = await rig.connect('A')
      const target = await createSession(rig, a, QUIET)
      await startTurn(a, target)
      await open(rig, target, 'edit-t7', 'Edit `a.ts`', 'edit')
      await rig.provider({
        op: 'askPermission',
        sessionId: target.sessionId,
        toolCallId: 'edit-t7',
      })
      const permission = await until(
        () => thread(a, target)?.interactions[0],
        'A to show the permission',
      )
      await a.client.commands.respondToInteraction({
        ...target,
        response: {
          kind: 'permission',
          interactionId: permission.interaction.interactionId,
          outcome: { outcome: 'selected', optionId: 'reject' },
        },
      })
      await untilThread(a, target, (state) => state.tools[0]?.status === 'declined', 'the refusal')
      await update(rig, target, 'edit-t7', { status: 'failed', rawOutput: 'User refused.' })
      await rig.waitQuiet()
      expect(toolOf(a, target)?.status).toBe('declined')
      await expectConverges('T7', rig, a)
      const before = a.connects
      await rig.crash()
      await until(() => a.connects > before, 'A to reconnect', 20_000)
      await until(() => !a.busy(), 'A to finish its reconnect')
      expect(toolOf(a, target)?.status).toBe('declined')
      await expectConverges('T7 after a restart', rig, a)
    },
  )

  scenario('T8 a 1 MB result stays off the socket and reads back whole', {}, async (rig) => {
    const a = await rig.connect('A')
    const target = await createSession(rig, a, QUIET)
    await startTurn(a, target)
    await open(rig, target, 'tool-t8')
    const result = `héllo\n${'x'.repeat(1 << 20)}`
    const mark = rig.proxy.frames.length
    await update(rig, target, 'tool-t8', { status: 'completed', rawOutput: result })
    await untilThread(a, target, (state) => state.tools[0]?.status === 'completed', 'the settle')
    const wire = JSON.stringify(rig.proxy.frames.slice(mark).map((frame) => frame.json ?? null))
    expect(wire.length).toBeLessThan(16 * 1024)
    expect(toolOf(a, target)?.outputBytes).toBe(Buffer.byteLength(result, 'utf8'))
    await expectConverges('T8', rig, a)
    expect(await readOutput(rig, target, toolOf(a, target)!.toolCallId)).toBe(result)
  })

  scenario('T9 a generated image keeps its tool across a restart', {}, async (rig) => {
    const a = await rig.connect('A')
    const target = await createSession(rig, a, QUIET)
    await startTurn(a, target)
    await open(rig, target, 'tool-t9')
    await update(rig, target, 'tool-t9', {
      status: 'completed',
      content: [{ type: 'content', content: { type: 'image', mimeType: 'image/png', data: PNG } }],
    })
    const artifact = () =>
      thread(a, target)
        ?.messages.flatMap((message) => message.content)
        .find((block) => block.type === 'artifact')
    await until(artifact, 'the image')
    const toolCallId = toolOf(a, target)!.toolCallId
    expect(artifact()).toMatchObject({ toolCallId })
    const before = a.connects
    await rig.crash()
    await until(() => a.connects > before, 'A to reconnect', 20_000)
    await until(() => !a.busy(), 'A to finish its reconnect')
    expect(artifact()).toMatchObject({ toolCallId })
    await expectConverges('T9', rig, a)
  })

  scenario('T10 no file body crosses the wire or reaches a row', {}, async (rig) => {
    const a = await rig.connect('A')
    const target = await createSession(rig, a, QUIET)
    await startTurn(a, target)
    const mark = rig.proxy.frames.length
    await open(rig, target, 'read-t10', 'Read src/a.ts', 'read')
    await update(rig, target, 'read-t10', {
      status: 'completed',
      rawOutput: { content: 'READ BODY' },
      locations: [{ path: 'src/a.ts' }],
    })
    await open(rig, target, 'edit-t10', 'Edit File', 'edit')
    await update(rig, target, 'edit-t10', {
      status: 'completed',
      rawInput: { path: 'src/b.ts', old_string: 'OLD BODY', new_string: 'NEW BODY' },
      content: [{ type: 'diff', path: 'src/b.ts', oldText: 'OLD BODY', newText: 'NEW BODY' }],
    })
    await open(rig, target, 'patch-t10', 'apply_patch', 'edit')
    await update(rig, target, 'patch-t10', {
      status: 'completed',
      rawInput: { patchText: 'PATCH BODY' },
      rawOutput: { output: 'patched', metadata: { diff: 'METADATA BODY' } },
    })
    await untilThread(
      a,
      target,
      (state) =>
        state.tools.length === 3 && state.tools.every((tool) => tool.status === 'completed'),
      'the three tools',
    )
    const seen = JSON.stringify([
      rig.proxy.frames.slice(mark).map((frame) => frame.json ?? null),
      await rig.server.call({ op: 'readThread', ...target }),
    ])
    expect(seen).not.toMatch(/READ BODY|OLD BODY|NEW BODY|PATCH BODY|METADATA BODY/)
    expect(toolOf(a, target)?.locations).toEqual([{ path: 'src/a.ts' }])
    expect(toolOf(a, target, 1)?.locations).toEqual([{ path: 'src/b.ts' }])
    await expectConverges('T10', rig, a)
  })

  scenario('T11 output goes with its chat, and only its session reads it', {}, async (rig) => {
    const a = await rig.connect('A')
    const target = await createSession(rig, a, QUIET)
    await startTurn(a, target)
    await open(rig, target, 'tool-t11')
    await update(rig, target, 'tool-t11', { status: 'completed', rawOutput: 'kept' })
    await untilThread(a, target, (state) => state.tools[0]?.status === 'completed', 'the settle')
    const { toolCallId } = toolOf(a, target)!
    expect(await readOutput(rig, target, toolCallId)).toBe('kept')
    await expect(
      readOutput(rig, { ...target, sessionId: 'another-session' }, toolCallId),
    ).rejects.toThrow()
    const anonymous = await fetch(
      `http://127.0.0.1:${rig.server.port}/tool-output/${target.sessionId}/${toolCallId}`,
    )
    expect(anonymous.status).toBe(401)
    await a.client.commands.deleteSession(target.sessionId)
    await until(() => !a.client.getState().sessions[target.sessionId] || undefined, 'the delete')
    await expect(readOutput(rig, target, toolCallId)).rejects.toThrow()
  })
})
