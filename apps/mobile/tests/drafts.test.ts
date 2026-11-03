import { describe, expect, it, vi } from 'vitest'

import { createDiscardHandoff, draftDiscardable } from '../src/draft/discard-handoff'
import {
  createPhoneFetch,
  parseResponseHeaders,
  type BlobRequest,
} from '../src/environment/phone-fetch'
import { listShapeOf } from '../src/home/rows'

describe('the discard a draft page hands to the home', () => {
  it('waits while its draft is on screen, then discards it once', () => {
    const handoff = createDiscardHandoff()
    const discard = vi.fn()
    handoff.request('d1')
    handoff.settle('d1', discard)
    expect(discard).not.toHaveBeenCalled()
    expect(handoff.waiting()).toBe('d1')
    handoff.settle(null, discard)
    handoff.settle(null, discard)
    expect(discard.mock.calls).toEqual([['d1']])
    expect(handoff.waiting()).toBeNull()
  })

  it('keeps only the latest request, and drops it where drafts are not kept', () => {
    const handoff = createDiscardHandoff()
    const discard = vi.fn()
    handoff.request('d1')
    handoff.request('d2')
    handoff.settle('d3', discard)
    expect(discard.mock.calls).toEqual([['d2']])
    handoff.request('d4')
    handoff.settle(null, null)
    expect(handoff.waiting()).toBeNull()
    handoff.settle(null, discard)
    expect(discard).toHaveBeenCalledTimes(1)
  })

  it('tells its listeners when the request changes', () => {
    const handoff = createDiscardHandoff()
    const heard = vi.fn()
    const stop = handoff.subscribe(heard)
    handoff.request('d1')
    handoff.request('d1')
    handoff.settle(null, () => undefined)
    stop()
    handoff.request('d2')
    expect(heard).toHaveBeenCalledTimes(2)
  })
})

describe('whether a draft page offers Discard', () => {
  const edit = (launching = false) => ({ launching }) as never
  it('needs a draft that exists and is not being sent', () => {
    expect(draftDiscardable({ drafts: {}, draftEdits: {} }, 'd1')).toBe(false)
    expect(draftDiscardable({ drafts: {}, draftEdits: {} }, null)).toBe(false)
    expect(draftDiscardable({ drafts: { d1: {} as never }, draftEdits: {} }, 'd1')).toBe(true)
    expect(draftDiscardable({ drafts: {}, draftEdits: { d1: edit() } }, 'd1')).toBe(true)
    expect(
      draftDiscardable({ drafts: { d1: {} as never }, draftEdits: { d1: edit(true) } }, 'd1'),
    ).toBe(false)
  })
})

describe('the home list shape', () => {
  it('changes when rows come, go or move, not with what they show', () => {
    const key = (row: { id: string }) => row.id
    const a = listShapeOf([{ key: 'today', data: [{ id: 's1' }, { id: 's2' }] }], key)
    const same = listShapeOf([{ key: 'today', data: [{ id: 's1' }, { id: 's2' }] }], key)
    const moved = listShapeOf([{ key: 'today', data: [{ id: 's2' }, { id: 's1' }] }], key)
    const regrouped = listShapeOf(
      [
        { key: 'needs', data: [{ id: 's1' }] },
        { key: 'recent', data: [{ id: 's2' }] },
      ],
      key,
    )
    expect(same).toBe(a)
    expect(moved).not.toBe(a)
    expect(regrouped).not.toBe(a)
  })
})

/** A scripted XMLHttpRequest: answers with `status` and a Blob, or fails. */
function fakeRequest(answer: { status: number; fail?: boolean; headers?: string }) {
  const sent: { method?: string; url?: string; headers: [string, string][]; aborted: boolean } = {
    headers: [],
    aborted: false,
  }
  const request: BlobRequest = {
    responseType: '',
    response: null,
    status: 0,
    statusText: '',
    onload: null,
    onerror: null,
    ontimeout: null,
    onabort: null,
    open(method, url) {
      sent.method = method
      sent.url = url
    },
    setRequestHeader(name, value) {
      sent.headers.push([name, value])
    },
    getAllResponseHeaders: () => answer.headers ?? '',
    send() {
      queueMicrotask(() => {
        if (sent.aborted) return
        if (answer.fail) {
          request.onerror?.()
          return
        }
        request.status = answer.status
        request.response = new Blob(['bytes'], { type: 'image/png' })
        request.onload?.()
      })
    },
    abort() {
      sent.aborted = true
      request.onabort?.()
    },
  }
  return { request, sent }
}

describe('the phone fetch', () => {
  it('reads through XMLHttpRequest as a native Blob, with the headers asked for', async () => {
    const { request, sent } = fakeRequest({
      status: 200,
      headers: 'Content-Type: image/png\r\nCache-Control: no-store\r\n',
    })
    const base = vi.fn()
    const phoneFetch = createPhoneFetch({ fetch: base, createRequest: () => request })
    const response = await phoneFetch('https://env/artifacts/a1', {
      headers: { authorization: 'Bearer t' },
    })
    expect(base).not.toHaveBeenCalled()
    expect(sent).toMatchObject({ method: 'GET', url: 'https://env/artifacts/a1' })
    expect(sent.headers).toEqual([['authorization', 'Bearer t']])
    expect(request.responseType).toBe('blob')
    expect(response.ok).toBe(true)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(await (await response.blob()).text()).toBe('bytes')
  })

  it('answers a refusal with its status, and a failure as fetch does', async () => {
    const refused = createPhoneFetch({
      fetch: vi.fn(),
      createRequest: () => fakeRequest({ status: 404 }).request,
    })
    expect((await refused('https://env/a')).status).toBe(404)
    const down = createPhoneFetch({
      fetch: vi.fn(),
      createRequest: () => fakeRequest({ status: 0, fail: true }).request,
    })
    await expect(down('https://env/a')).rejects.toBeInstanceOf(TypeError)
  })

  it('aborts with the signal, and leaves anything but a read to fetch', async () => {
    const { request, sent } = fakeRequest({ status: 200 })
    const base = vi.fn(async () => new Response(null, { status: 201 }))
    const phoneFetch = createPhoneFetch({ fetch: base, createRequest: () => request })
    const controller = new AbortController()
    const read = phoneFetch('https://env/a', { signal: controller.signal })
    controller.abort()
    await expect(read).rejects.toMatchObject({ name: 'AbortError' })
    expect(sent.aborted).toBe(true)
    await expect(phoneFetch('https://env/a', { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    })

    const upload = await phoneFetch('https://env/upload', { method: 'PUT', body: 'x' })
    expect(upload.status).toBe(201)
    expect(base).toHaveBeenCalledWith('https://env/upload', { method: 'PUT', body: 'x' })
  })

  it('reads response headers line by line', () => {
    const headers = parseResponseHeaders('a: 1\r\nb:2\nbad line\n')
    expect(headers.get('a')).toBe('1')
    expect(headers.get('b')).toBe('2')
  })
})
