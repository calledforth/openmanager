import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ServerUpdateStatus } from '@openmanager/protocol'
import {
  createServerUpdateWatcher,
  fetchServerUpdateStatus,
  serverUpdateNotice,
  startServerUpdate,
} from '../src/server-update'

const idle: ServerUpdateStatus = {
  currentVersion: '0.21.0',
  latestVersion: '0.22.0',
  updateAvailable: true,
  checkedAt: '2026-11-26T00:00:00.000Z',
  canUpdate: true,
  state: 'idle',
}

afterEach(() => {
  vi.useRealTimers()
})

describe('server update over HTTP', () => {
  it('reads the status from /server-update under the endpoint, with the credential', async () => {
    const fetch = vi.fn(async () => Response.json(idle))
    const status = await fetchServerUpdateStatus(
      { endpoint: 'https://om.example.com/prefix', credential: 'secret', fetch },
      { check: true },
    )
    expect(status).toMatchObject({ latestVersion: '0.22.0' })
    expect(fetch).toHaveBeenCalledWith('https://om.example.com/prefix/server-update?check=1', {
      headers: { authorization: 'Bearer secret' },
    })
  })

  it('says a server without the route is unsupported', async () => {
    const fetch = vi.fn(async () => new Response('Not found', { status: 404 }))
    expect(
      await fetchServerUpdateStatus({ endpoint: 'http://127.0.0.1:43120', credential: 'c', fetch }),
    ).toBe('unsupported')
  })

  it('carries the server refusal into a typed error', async () => {
    const fetch = vi.fn(async () =>
      Response.json(
        { error: { code: 'capability_missing', message: 'needs the admin permission' } },
        { status: 403 },
      ),
    )
    await expect(
      startServerUpdate({ endpoint: 'http://127.0.0.1:43120', credential: 'c', fetch }),
    ).rejects.toMatchObject({ code: 'capability_missing', message: 'needs the admin permission' })
  })
})

describe('server update watcher', () => {
  it('follows an update through the restart and says once that it finished', async () => {
    vi.useFakeTimers()
    const answers: (ServerUpdateStatus | Error)[] = [
      idle,
      new Error('fetch failed'),
      { ...idle, currentVersion: '0.22.0', updateAvailable: false, updatedFrom: '0.21.0' },
    ]
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return Response.json(
          { ...idle, state: 'updating', targetVersion: '0.22.0' },
          { status: 202 },
        )
      }
      const next = answers.shift() ?? answers.at(-1)!
      if (next instanceof Error) throw next
      return Response.json(next)
    }) as unknown as typeof globalThis.fetch
    const watcher = createServerUpdateWatcher({
      endpoint: 'http://127.0.0.1:43120',
      credential: 'c',
      fetch,
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(serverUpdateNotice(watcher.getSnapshot())).toEqual({
      kind: 'available',
      from: '0.21.0',
      to: '0.22.0',
      canUpdate: true,
    })
    await watcher.update()
    expect(serverUpdateNotice(watcher.getSnapshot())).toEqual({ kind: 'updating', to: '0.22.0' })
    // The server is down: still updating, no error.
    await vi.advanceTimersByTimeAsync(2_000)
    expect(watcher.getSnapshot().error).toBeUndefined()
    expect(serverUpdateNotice(watcher.getSnapshot()).kind).toBe('updating')
    // Back, on the new version.
    await vi.advanceTimersByTimeAsync(2_000)
    expect(serverUpdateNotice(watcher.getSnapshot())).toEqual({
      kind: 'updated',
      from: '0.21.0',
      to: '0.22.0',
    })
    watcher.acknowledge()
    expect(serverUpdateNotice(watcher.getSnapshot())).toEqual({ kind: 'none' })
    watcher.dispose()
  })

  it('shows a failed update with the reason', () => {
    expect(
      serverUpdateNotice({
        status: { ...idle, state: 'failed', targetVersion: '0.22.0', error: 'Checksum mismatch' },
        unsupported: false,
        starting: false,
        error: undefined,
        justUpdated: undefined,
      }),
    ).toEqual({ kind: 'failed', to: '0.22.0', error: 'Checksum mismatch' })
  })
})
