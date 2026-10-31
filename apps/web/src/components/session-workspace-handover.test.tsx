import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createInitialState, type EnvironmentClient } from '@openmanager/environment-client'
import { EnvironmentClientProvider } from '@openmanager/app-core/providers/environment-client'
import { SessionWorkspace } from './session-workspace'

vi.mock('@openmanager/app-core/components/chat/ChatWorkspace', () => ({
  ChatWorkspace: () => <p>chat</p>,
}))
vi.mock('../providers/connection-provider', () => ({
  useConnection: () => ({ ui: { kind: 'ready' } }),
}))
vi.mock('@tanstack/react-router', () => {
  const navigate = vi.fn()
  return { useNavigate: () => navigate }
})

afterEach(cleanup)

function clientWith({ known, connected }: { known: boolean; connected: boolean }) {
  const initial = createInitialState()
  const state = {
    ...initial,
    sessions: known ? ({ cached: {} } as never) : initial.sessions,
    connection: { ...initial.connection, phase: connected ? 'connected' : 'reconnecting' },
  }
  const listeners = new Set<() => void>()
  return {
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    commands: { openSession: vi.fn(async () => undefined) },
    setActiveSession: vi.fn(),
  } as unknown as EnvironmentClient & {
    commands: { openSession: ReturnType<typeof vi.fn> }
    setActiveSession: ReturnType<typeof vi.fn>
  }
}

const page = (client: EnvironmentClient) => (
  <EnvironmentClientProvider client={client}>
    <SessionWorkspace sessionId="cached" />
  </EnvironmentClientProvider>
)

describe('SessionWorkspace with a client that may not have connected', () => {
  it('shows no empty chat for a session it cannot read or ask for', () => {
    const client = clientWith({ known: false, connected: false })
    render(page(client))

    expect(screen.queryByText('chat')).not.toBeInTheDocument()
    expect(screen.getByText(/Connect to an environment/)).toBeInTheDocument()
    expect(client.commands.openSession).not.toHaveBeenCalled()
  })

  it('asks for a session it does not know once it can', () => {
    const client = clientWith({ known: false, connected: true })
    render(page(client))

    expect(screen.getByText('chat')).toBeInTheDocument()
    expect(client.commands.openSession).toHaveBeenCalledWith('cached')
  })

  it('opens a chat once when the client is handed over as it connects', () => {
    const client = clientWith({ known: true, connected: false })
    // What the provider does: a view of the client first, the client itself after.
    const { rerender } = render(page({ ...client }))
    expect(client.commands.openSession).toHaveBeenCalledTimes(1)

    act(() => rerender(page(client)))

    expect(client.commands.openSession).toHaveBeenCalledTimes(1)
    expect(client.setActiveSession).not.toHaveBeenCalled()
  })
})
