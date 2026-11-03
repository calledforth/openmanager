/**
 * The `fetch` the phone's environment client is given. Reads (`GET`: an
 * image a draft or a message keeps) go through React Native's own
 * XMLHttpRequest, which hands back a native Blob of the bytes. Expo's global
 * `fetch` builds its Blob from an ArrayBuffer, which React Native's Blob
 * refuses, so an image another device attached could never be shown here.
 * Everything else (an upload's `PUT`) goes through `fetch` unchanged.
 */

/** The parts of React Native's XMLHttpRequest this uses. */
export interface BlobRequest {
  responseType: string
  response: unknown
  status: number
  statusText: string
  onload: (() => void) | null
  onerror: (() => void) | null
  ontimeout: (() => void) | null
  onabort: (() => void) | null
  open(method: string, url: string): void
  setRequestHeader(name: string, value: string): void
  getAllResponseHeaders(): string
  send(body?: null): void
  abort(): void
}

export interface PhoneFetchPorts {
  fetch: typeof fetch
  createRequest: () => BlobRequest
  /** Builds the answer; the global `Response` (React Native's fetch polyfill) by default. */
  respond?: (body: Blob, init: ResponseInit) => Response
}

const abortError = () => {
  const error = new Error('Aborted')
  error.name = 'AbortError'
  return error
}

/** `name: value` lines as headers. */
export function parseResponseHeaders(raw: string): Headers {
  const headers = new Headers()
  for (const line of raw.split(/\r?\n/)) {
    const at = line.indexOf(':')
    if (at <= 0) continue
    headers.append(line.slice(0, at).trim(), line.slice(at + 1).trim())
  }
  return headers
}

function headerEntries(init: HeadersInit | undefined): [string, string][] {
  if (!init) return []
  if (init instanceof Headers) {
    const entries: [string, string][] = []
    init.forEach((value, name) => entries.push([name, value]))
    return entries
  }
  return Array.isArray(init) ? init.map(([name, value]) => [name, value]) : Object.entries(init)
}

export function createPhoneFetch({ fetch: base, createRequest, respond }: PhoneFetchPorts) {
  const answer = respond ?? ((body: Blob, init: ResponseInit) => new Response(body, init))
  return function phoneFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const method = (init?.method ?? 'GET').toUpperCase()
    if (method !== 'GET' || typeof input !== 'string') return base(input, init)
    const signal = init?.signal ?? null
    if (signal?.aborted) return Promise.reject(abortError())
    return new Promise<Response>((resolve, reject) => {
      const request = createRequest()
      const onAbort = () => request.abort()
      const done = () => signal?.removeEventListener('abort', onAbort)
      request.onload = () => {
        done()
        try {
          resolve(
            answer(request.response as Blob, {
              status: request.status,
              statusText: request.statusText,
              headers: parseResponseHeaders(request.getAllResponseHeaders()),
            }),
          )
        } catch (error) {
          reject(error instanceof Error ? error : new TypeError('Network request failed'))
        }
      }
      request.onerror = request.ontimeout = () => {
        done()
        reject(new TypeError('Network request failed'))
      }
      request.onabort = () => {
        done()
        reject(abortError())
      }
      request.open('GET', input)
      for (const [name, value] of headerEntries(init?.headers)) {
        request.setRequestHeader(name, value)
      }
      request.responseType = 'blob'
      signal?.addEventListener('abort', onAbort)
      request.send(null)
    })
  }
}
