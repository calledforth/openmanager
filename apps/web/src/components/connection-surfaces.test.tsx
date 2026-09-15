import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { deriveConnectionUi } from '../lib/connection-state'
import { CONNECTION_STORIES } from '../stories/connection-states'
import {
  ConnectionBanner,
  ConnectionScreen,
  EnvironmentConnectForm,
  EnvironmentList,
} from './connection-surfaces'

afterEach(() => {
  cleanup()
})

describe('connection surfaces', () => {
  it('renders a distinct product surface for every story', () => {
    for (const story of CONNECTION_STORIES) {
      const state = deriveConnectionUi(story.input)
      const view =
        state.surface === 'banner' ? (
          <ConnectionBanner state={state} />
        ) : (
          <ConnectionScreen state={state} />
        )
      const { unmount } = render(view)
      expect(screen.getByText(state.title)).toBeInTheDocument()
      expect(screen.getByText(state.description)).toBeInTheDocument()
      unmount()
    }
  })

  it('keeps session chrome visible for reconnecting banners', () => {
    const story = CONNECTION_STORIES.find((item) => item.id === 'reconnecting')
    if (!story) throw new Error('missing reconnecting story')
    const state = deriveConnectionUi(story.input)
    render(
      <div>
        <ConnectionBanner state={state} />
        <p>Session workspace stays mounted</p>
      </div>,
    )
    expect(screen.getByRole('status')).toHaveTextContent('Reconnecting')
    expect(screen.getByText('Session workspace stays mounted')).toBeInTheDocument()
  })

  it('states offline politely while the network is gone, with nothing to press', () => {
    const story = CONNECTION_STORIES.find((item) => item.id === 'offline')
    if (!story) throw new Error('missing offline story')
    const state = deriveConnectionUi(story.input)
    render(<ConnectionBanner state={state} />)
    expect(screen.getByRole('status')).toHaveTextContent('No network')
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.getByText(state.description)).toBeInTheDocument()
  })

  it('offers a manual retry once the client has stopped retrying', async () => {
    const user = userEvent.setup()
    const onRetry = vi.fn()
    const onChangeEnvironment = vi.fn()
    const state = deriveConnectionUi({
      environment: { status: 'selected', endpoint: 'http://127.0.0.1:43120', label: 'Home' },
      bootstrap: { status: 'loading' },
      transport: { phase: 'closed', hasConnected: true, failure: null, retriesExhausted: true },
      network: { online: true },
    })
    render(<ConnectionBanner state={state} handlers={{ onRetry, onChangeEnvironment }} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Not connected')
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Change environment' }))
    expect(onChangeEnvironment).toHaveBeenCalled()
  })

  it('submits a valid endpoint and optional token, and rejects a bad one', async () => {
    const user = userEvent.setup()
    const onConnect = vi.fn()
    render(<EnvironmentConnectForm onConnect={onConnect} />)

    await user.type(screen.getByLabelText('Environment endpoint'), 'not-a-url')
    await user.click(screen.getByRole('button', { name: 'Connect' }))
    expect(onConnect).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('http(s) environment URL')

    await user.clear(screen.getByLabelText('Environment endpoint'))
    await user.type(screen.getByLabelText('Environment endpoint'), 'http://127.0.0.1:43120/')
    await user.type(screen.getByLabelText('Client token'), 'dev-token')
    await user.click(screen.getByRole('button', { name: 'Connect' }))
    expect(onConnect).toHaveBeenCalledWith('http://127.0.0.1:43120', 'dev-token')
  })

  it('lists saved environments for select and remove', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    const onRemove = vi.fn()
    render(
      <EnvironmentList
        selectedId="env-a"
        onSelect={onSelect}
        onRemove={onRemove}
        environments={[
          {
            environmentId: 'env-a',
            label: 'Home',
            endpoints: ['http://127.0.0.1:43120'],
            credential: 'token',
          },
          {
            environmentId: 'env-b',
            label: 'Lab',
            endpoints: ['https://tunnel.example'],
            credential: '',
          },
        ]}
      />,
    )

    expect(screen.getByText('Home · Selected')).toBeInTheDocument()
    expect(screen.getByText('Client token saved')).toBeInTheDocument()
    expect(screen.getByText('No client token')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Select' }))
    expect(onSelect).toHaveBeenCalledWith('env-b')
    await user.click(screen.getAllByRole('button', { name: 'Remove' })[1]!)
    expect(onRemove).toHaveBeenCalledWith('env-b')
  })
})
