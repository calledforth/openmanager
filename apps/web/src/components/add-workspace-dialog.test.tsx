import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  EnvironmentClientError,
  createMockEnvironmentClient,
  type EnvironmentClient,
} from '@openmanager/environment-client'
import { AddWorkspaceDialog } from './add-workspace-dialog'

afterEach(() => {
  cleanup()
})

/** A client whose add command answers the way a server would. */
function clientRejectingWith(error: Error): EnvironmentClient {
  const client = createMockEnvironmentClient()
  return {
    ...client,
    commands: { ...client.commands, addWorkspace: () => Promise.reject(error) },
  }
}

describe('add workspace dialog', () => {
  it('sends the typed path to the environment and closes on success', async () => {
    const user = userEvent.setup()
    const client = createMockEnvironmentClient()
    const onClose = vi.fn()
    render(<AddWorkspaceDialog client={client} open onClose={onClose} />)
    await user.type(screen.getByLabelText('Folder path'), '  /home/me/project  ')
    await user.click(screen.getByRole('button', { name: 'Add project' }))
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(client.calls).toEqual([{ command: 'addWorkspace', input: { path: '/home/me/project' } }])
    expect(client.getState().workspaces['/home/me/project']).toMatchObject({ name: 'project' })
  })

  it('shows the environment refusal in place and keeps the typed path', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const client = clientRejectingWith(
      new EnvironmentClientError('not_found', 'No folder exists at that path on this environment.'),
    )
    render(<AddWorkspaceDialog client={client} open onClose={onClose} />)
    await user.type(screen.getByLabelText('Folder path'), 'C:\\missing')
    await user.click(screen.getByRole('button', { name: 'Add project' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'No folder exists at that path on this environment.',
    )
    expect(screen.getByLabelText('Folder path')).toHaveValue('C:\\missing')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('refuses an empty path without asking the environment', async () => {
    const user = userEvent.setup()
    const client = createMockEnvironmentClient()
    render(<AddWorkspaceDialog client={client} open onClose={() => undefined} />)
    await user.click(screen.getByRole('button', { name: 'Add project' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter the path of a folder')
    expect(client.calls).toEqual([])
  })

  it('closes on cancel and on Escape without adding anything', async () => {
    const user = userEvent.setup()
    const client = createMockEnvironmentClient()
    const onClose = vi.fn()
    render(<AddWorkspaceDialog client={client} open onClose={onClose} />)
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(2)
    expect(client.calls).toEqual([])
  })

  it('ignores Escape while the environment is still answering', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const client = createMockEnvironmentClient()
    const pending: EnvironmentClient = {
      ...client,
      commands: { ...client.commands, addWorkspace: () => new Promise(() => undefined) },
    }
    render(<AddWorkspaceDialog client={pending} open onClose={onClose} />)
    await user.type(screen.getByLabelText('Folder path'), '/home/me/project')
    await user.click(screen.getByRole('button', { name: 'Add project' }))
    expect(await screen.findByRole('button', { name: 'Adding…' })).toBeDisabled()
    await user.keyboard('{Escape}')
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('renders nothing while closed', () => {
    render(
      <AddWorkspaceDialog
        client={createMockEnvironmentClient()}
        open={false}
        onClose={() => undefined}
      />,
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
