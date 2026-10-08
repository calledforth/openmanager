import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { deriveConnectionUi } from '../lib/connection-state'
import { routeTypeForEndpoint, type EnvironmentRoute } from '../lib/environment-store'
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

function route(
  endpoint: string,
  priority = 0,
  health: EnvironmentRoute['health'] = { status: 'unknown' },
): EnvironmentRoute {
  return { type: routeTypeForEndpoint(endpoint), endpoint, priority, health }
}

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

  it('offers the blank-token owner claim only in a build that can make it', () => {
    const { unmount } = render(<EnvironmentConnectForm onConnect={vi.fn()} canClaimOwner />)
    expect(screen.getByText(/Leave it blank on localhost/)).toBeInTheDocument()
    unmount()

    // A hosted build has no claim key: the token comes from the data directory or a link.
    render(<EnvironmentConnectForm onConnect={vi.fn()} canClaimOwner={false} />)
    expect(screen.queryByText(/Leave it blank on localhost/)).not.toBeInTheDocument()
    expect(screen.getByText(/paste the token from owner-credential/)).toBeInTheDocument()
    expect(screen.getByText(/open a pairing link instead/)).toBeInTheDocument()
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
            routes: [route('http://127.0.0.1:43120')],
            credential: 'token',
          },
          {
            environmentId: 'env-b',
            label: 'Lab',
            routes: [route('https://tunnel.example')],
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

  it('lists every route with its type and health, and marks the one in use', async () => {
    const user = userEvent.setup()
    const onChooseRoute = vi.fn()
    const onRemoveRoute = vi.fn()
    const onCheckRoutes = vi.fn()
    render(
      <EnvironmentList
        selectedId="env-a"
        onChooseRoute={onChooseRoute}
        onRemoveRoute={onRemoveRoute}
        onCheckRoutes={onCheckRoutes}
        environments={[
          {
            environmentId: 'env-a',
            label: 'Home',
            routes: [
              route('http://127.0.0.1:43120', 0, { status: 'available' }),
              route('https://tunnel.example', 1, {
                status: 'unreachable',
                message: 'Could not reach https://tunnel.example.',
              }),
              route('https://gated.example', 2, { status: 'unauthorized' }),
            ],
            credential: 'token',
          },
        ]}
      />,
    )

    expect(onCheckRoutes).toHaveBeenCalledTimes(1)
    const rows = within(screen.getByRole('list', { name: 'Routes to Home' })).getAllByRole(
      'listitem',
    )
    expect(rows.map((row) => row.textContent)).toEqual([
      'http://127.0.0.1:43120Local · Available · In use' + 'Forget',
      'https://tunnel.exampleRemote · Unavailable' + 'Use' + 'Forget',
      'https://gated.exampleRemote · Not authorized' + 'Use' + 'Forget',
    ])
    expect(screen.getByText('Unavailable')).toHaveAttribute(
      'title',
      'Could not reach https://tunnel.example.',
    )

    await user.click(screen.getByRole('button', { name: 'Use https://tunnel.example' }))
    expect(onChooseRoute).toHaveBeenCalledWith('env-a', 'https://tunnel.example')
    await user.click(screen.getByRole('button', { name: 'Forget https://gated.example' }))
    expect(onRemoveRoute).toHaveBeenCalledWith('env-a', 'https://gated.example')
  })

  it('offers to make a route that took over the first choice', async () => {
    const user = userEvent.setup()
    const onChooseRoute = vi.fn()
    render(
      <EnvironmentList
        selectedId="env-a"
        inUseEndpoint="https://tunnel.example"
        onChooseRoute={onChooseRoute}
        environments={[
          {
            environmentId: 'env-a',
            label: 'Home',
            routes: [
              route('https://first.example', 0, { status: 'unreachable' }),
              route('https://tunnel.example', 1, { status: 'available' }),
            ],
            credential: 'token',
          },
        ]}
      />,
    )

    const rows = within(screen.getByRole('list', { name: 'Routes to Home' })).getAllByRole(
      'listitem',
    )
    expect(rows.map((row) => row.textContent)).toEqual([
      'https://first.exampleRemote · Unavailable' + 'Use',
      'https://tunnel.exampleRemote · Available · In use' + 'Make first',
    ])
    await user.click(
      screen.getByRole('button', { name: 'Make https://tunnel.example the first choice' }),
    )
    expect(onChooseRoute).toHaveBeenCalledWith('env-a', 'https://tunnel.example')
  })

  it('offers nothing to choose or forget for the only route of an environment', () => {
    render(
      <EnvironmentList
        selectedId={null}
        onChooseRoute={vi.fn()}
        onRemoveRoute={vi.fn()}
        environments={[
          {
            environmentId: 'env-a',
            label: 'Home',
            routes: [route('http://127.0.0.1:43120')],
            credential: '',
          },
        ]}
      />,
    )
    expect(screen.getByText('Not checked')).toBeInTheDocument()
    // Selecting the environment already uses its first route.
    expect(screen.queryByRole('button', { name: /^Use/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Forget/ })).not.toBeInTheDocument()
  })
})
