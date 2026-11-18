import { describe, expect, it, vi } from 'vitest'
import type { ArtifactMetadata } from '../src/artifacts.js'
import { ShareRefusedError } from '../src/artifacts.js'
import { createShareFileTool } from '../src/share-file-tool.js'

const METADATA: ArtifactMetadata = {
  artifactId: '00000000-0000-4000-8000-000000000001',
  sessionId: 'session-1',
  workspaceId: 'workspace-1',
  name: 'flow.mp4',
  mimeType: 'video/mp4',
  sizeBytes: 3 * 1024 * 1024,
  createdAt: 1,
  source: 'generated',
}
const TURN = { sessionId: 'session-1', workspaceId: 'workspace-1', cwd: '/work', turnId: 'turn-1' }
const context = { threadId: 'thread-1', providerId: 'claude' as const }

function tool(overrides: Partial<Parameters<typeof createShareFileTool>[0]> = {}) {
  const deps = {
    agentTurnOf: vi.fn(() => TURN),
    share: vi.fn(async () => METADATA),
    present: vi.fn(() => true),
    discard: vi.fn(),
    ...overrides,
  }
  return { deps, tool: createShareFileTool(deps) }
}

describe('share_file', () => {
  it('resolves a relative path in the working directory and files it into that turn', async () => {
    const { deps, tool: share } = tool()
    const result = await share.call({ path: 'recordings/flow.mp4' }, context)
    expect(deps.share).toHaveBeenCalledWith('session-1', 'workspace-1', '/work/recordings/flow.mp4')
    expect(deps.present).toHaveBeenCalledWith('thread-1', 'turn-1', METADATA)
    expect(result).toEqual({
      text: expect.stringMatching(/^Shared flow\.mp4 \(video, 3\.0 MB\) in the chat/),
    })
  })

  it('throws the copy away when its turn ended while it was being made', async () => {
    const { deps, tool: share } = tool({ present: vi.fn(() => false) })
    const result = await share.call({ path: '/work/flow.mp4' }, context)
    expect(result.isError).toBe(true)
    expect(deps.discard).toHaveBeenCalledWith(METADATA)
  })

  it('answers a refusal in the words the store gave it', async () => {
    const { tool: share } = tool({
      share: vi.fn(async () => {
        throw new ShareRefusedError('/work/key is not a video or image the chat can show.')
      }),
    })
    expect(await share.call({ path: '/work/key' }, context)).toEqual({
      text: '/work/key is not a video or image the chat can show.',
      isError: true,
    })
  })

  it('refuses between turns, before touching the file', async () => {
    const { deps, tool: share } = tool({ agentTurnOf: vi.fn(() => undefined) })
    expect((await share.call({ path: 'flow.mp4' }, context)).isError).toBe(true)
    expect(deps.share).not.toHaveBeenCalled()
  })

  it('tells the agent the limits it is held to', () => {
    expect(tool().tool.description).toMatch(/videos up to 1 GB, images up to 25 MB/)
  })
})
