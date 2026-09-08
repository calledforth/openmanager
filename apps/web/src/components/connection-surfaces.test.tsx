import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { deriveConnectionUi } from '../lib/connection-state'
import { CONNECTION_STORIES } from '../stories/connection-states'
import { ConnectionBanner, ConnectionScreen, EnvironmentConnectForm } from './connection-surfaces'

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

  it('submits a valid endpoint and rejects a bad one', async () => {
    const user = userEvent.setup()
    const onConnect = vi.fn()
    render(<EnvironmentConnectForm onConnect={onConnect} />)

    await user.type(screen.getByLabelText('Environment endpoint'), 'not-a-url')
    await user.click(screen.getByRole('button', { name: 'Connect' }))
    expect(onConnect).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('http(s) environment URL')

    await user.clear(screen.getByLabelText('Environment endpoint'))
    await user.type(screen.getByLabelText('Environment endpoint'), 'http://127.0.0.1:43120/')
    await user.click(screen.getByRole('button', { name: 'Connect' }))
    expect(onConnect).toHaveBeenCalledWith('http://127.0.0.1:43120')
  })
})
