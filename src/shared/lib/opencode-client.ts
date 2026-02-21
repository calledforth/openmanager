export interface HealthResponse {
  healthy: boolean
  version?: string
}

export interface OcSession {
  id: string
  title?: string
  status?: string
  createdAt?: string
}

export interface OcProvider {
  id: string
  name: string
}

export class OpenCodeClient {
  constructor(
    private baseUrl: string,
    private password: string,
  ) {}

  private headers(): Record<string, string> {
    const credentials = Buffer.from(`opencode:${this.password}`).toString('base64')
    return {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/json',
    }
  }

  private async request<T>(path: string, opts: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...opts,
      headers: { ...this.headers(), ...(opts.headers as Record<string, string>) },
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new OpenCodeError(res.status, text, path)
    }
    const text = await res.text()
    if (!text) return undefined as T
    return JSON.parse(text)
  }

  health(): Promise<HealthResponse> {
    return this.request('/global/health')
  }

  listSessions(): Promise<OcSession[]> {
    return this.request('/session')
  }

  createSession(title?: string): Promise<OcSession> {
    return this.request('/session', {
      method: 'POST',
      body: JSON.stringify(title ? { title } : {}),
    })
  }

  getSession(id: string): Promise<OcSession> {
    return this.request(`/session/${id}`)
  }

  deleteSession(id: string): Promise<void> {
    return this.request(`/session/${id}`, { method: 'DELETE' })
  }

  sendMessage(sessionId: string, content: string): Promise<void> {
    return this.request(`/session/${sessionId}/message`, {
      method: 'POST',
      body: JSON.stringify({ parts: [{ type: 'text', text: content }] }),
    })
  }

  sendMessageAsync(sessionId: string, content: string): Promise<void> {
    return this.request(`/session/${sessionId}/prompt_async`, {
      method: 'POST',
      body: JSON.stringify({ parts: [{ type: 'text', text: content }] }),
    })
  }

  abortSession(sessionId: string): Promise<void> {
    return this.request(`/session/${sessionId}/abort`, { method: 'POST' })
  }

  resolvePermission(sessionId: string, permissionId: string, approved: boolean): Promise<void> {
    return this.request(`/session/${sessionId}/permissions/${permissionId}`, {
      method: 'POST',
      body: JSON.stringify({ approved }),
    })
  }

  getDiff(sessionId: string): Promise<unknown> {
    return this.request(`/session/${sessionId}/diff`)
  }

  getProviders(): Promise<OcProvider[]> {
    return this.request('/provider')
  }
}

export class OpenCodeError extends Error {
  constructor(
    public status: number,
    public body: string,
    public path: string,
  ) {
    super(`OpenCode ${status} on ${path}: ${body}`)
    this.name = 'OpenCodeError'
  }
}
