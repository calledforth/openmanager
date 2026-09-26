import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  EnvironmentClientError,
  WIRE_COMMANDS,
  createMockEnvironmentClient as createMockClient,
  type EnvironmentClient,
  type EnvironmentCommandName,
  type MockEnvironmentClientOptions,
} from '@openmanager/environment-client'
import { AddWorkspaceDialog } from './add-workspace-dialog'

afterEach(() => {
  cleanup()
})

/** An environment from before folder browsing: the dialog asks for a typed path. */
const createMockEnvironmentClient = (options: MockEnvironmentClientOptions = {}) =>
  createMockClient({
    ...options,
    capabilities: (Object.keys(WIRE_COMMANDS) as EnvironmentCommandName[]).filter(
      (command) => command !== 'browseFolders',
    ),
  })

/** A client whose add command answers the way a server would. */
function clientRejectingWith(error: Error): EnvironmentClient {
  const client = createMockEnvironmentClient()
  return {
    ...client,
    commands: { ...client.commands, addWorkspace: () => Promise.reject(error) },
  }
}

describe('add workspace dialog without folder browsing', () => {
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

const FOLDERS = {
  'C:\\': ['Users'],
  'C:\\Users': ['you'],
  'C:\\Users\\you': ['code', '.config', 'Documents'],
  'C:\\Users\\you\\code': ['tend', 'openmanager', 'openmanager-web'],
  'C:\\Users\\you\\code\\openmanager': [],
  'C:\\Users\\you\\code\\openmanager-web': [],
  'C:\\Users\\you\\code\\tend': [],
  'C:\\Users\\you\\Documents': [],
}

function browsingClient(
  options: Omit<MockEnvironmentClientOptions, 'seed'> & { startsIn?: string } = {},
) {
  return createMockClient({
    ...options,
    seed: {
      folders: FOLDERS,
      home: 'C:\\Users\\you',
      environmentSettings: { addProjectStartsIn: options.startsIn ?? '' },
    },
  })
}

const rows = () => screen.queryAllByRole('option').map((row) => row.textContent)
const field = () => screen.getByLabelText<HTMLInputElement>('Folder path')

describe('add project folder browser', () => {
  it('opens in the home folder, listing its folders without the dot ones', async () => {
    render(<AddWorkspaceDialog client={browsingClient()} open onClose={() => undefined} />)
    await waitFor(() => expect(field()).toHaveValue('C:\\Users\\you\\'))
    expect(rows()).toEqual(['code', 'Documents'])
  })

  it('opens where the environment setting says', async () => {
    render(
      <AddWorkspaceDialog
        client={browsingClient({ startsIn: 'C:\\Users\\you\\code' })}
        open
        onClose={() => undefined}
      />,
    )
    await waitFor(() => expect(field()).toHaveValue('C:\\Users\\you\\code\\'))
    expect(rows()).toEqual(['openmanager', 'openmanager-web', 'tend'])
  })

  it('narrows by what is typed, steps in with Enter and back out with Alt+Up', async () => {
    const user = userEvent.setup()
    render(<AddWorkspaceDialog client={browsingClient()} open onClose={() => undefined} />)
    await waitFor(() => expect(rows()).toEqual(['code', 'Documents']))
    await user.type(field(), 'co')
    expect(rows()).toEqual(['code'])
    await user.keyboard('{Enter}')
    await waitFor(() => expect(field()).toHaveValue('C:\\Users\\you\\code\\'))
    await waitFor(() => expect(rows()).toEqual(['openmanager', 'openmanager-web', 'tend']))
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}')
    await waitFor(() => expect(field()).toHaveValue('C:\\Users\\you\\'))
  })

  it('shows dot folders once the typed name starts with a dot', async () => {
    const user = userEvent.setup()
    render(<AddWorkspaceDialog client={browsingClient()} open onClose={() => undefined} />)
    await waitFor(() => expect(rows()).toEqual(['code', 'Documents']))
    await user.type(field(), '.')
    expect(rows()).toEqual(['.config'])
  })

  it('adds the folder the field names with Ctrl+Enter and closes', async () => {
    const user = userEvent.setup()
    const client = browsingClient({ startsIn: 'C:\\Users\\you\\code' })
    const onClose = vi.fn()
    render(<AddWorkspaceDialog client={client} open onClose={onClose} />)
    await waitFor(() => expect(rows()).toHaveLength(3))
    // "openmanager" also prefixes "openmanager-web": the exact name wins.
    await user.type(field(), 'openmanager')
    expect(screen.getByRole('button', { name: /Add openmanager/ })).toBeEnabled()
    await user.keyboard('{Control>}{Enter}{/Control}')
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(client.calls.filter((call) => call.command === 'addWorkspace')).toEqual([
      { command: 'addWorkspace', input: { path: 'C:\\Users\\you\\code\\openmanager' } },
    ])
  })

  it('adds the listed folder itself from the button', async () => {
    const user = userEvent.setup()
    const client = browsingClient({ startsIn: 'C:\\Users\\you\\code' })
    const onClose = vi.fn()
    render(<AddWorkspaceDialog client={client} open onClose={onClose} />)
    await user.click(await screen.findByRole('button', { name: /Add code/ }))
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(client.getState().workspaces['C:\\Users\\you\\code']).toMatchObject({ name: 'code' })
  })

  it('keeps the palette open and says why when the environment refuses', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const client = browsingClient()
    const refusing: EnvironmentClient = {
      ...client,
      commands: {
        ...client.commands,
        addWorkspace: () =>
          Promise.reject(
            new EnvironmentClientError('conflict', 'That folder is already a project.'),
          ),
      },
    }
    render(<AddWorkspaceDialog client={refusing} open onClose={onClose} />)
    await user.click(await screen.findByRole('button', { name: /Add you/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('That folder is already a project.')
    expect(onClose).not.toHaveBeenCalled()
    expect(field()).toHaveValue('C:\\Users\\you\\')
  })

  it('opens at home when the start folder has gone', async () => {
    render(
      <AddWorkspaceDialog
        client={browsingClient({ startsIn: 'C:\\Users\\you\\gone' })}
        open
        onClose={() => undefined}
      />,
    )
    await waitFor(() => expect(field()).toHaveValue('C:\\Users\\you\\'))
  })

  it('ignores rows of the last folder while the next one loads', async () => {
    const user = userEvent.setup()
    const client = browsingClient()
    const browseFolders = client.commands.browseFolders
    const slow: EnvironmentClient = {
      ...client,
      commands: {
        ...client.commands,
        browseFolders: (path, prefix) =>
          path === 'C:\\Users\\you\\code\\'
            ? new Promise(() => undefined)
            : browseFolders(path, prefix),
      },
    }
    render(<AddWorkspaceDialog client={slow} open onClose={() => undefined} />)
    await waitFor(() => expect(rows()).toEqual(['code', 'Documents']))
    await user.keyboard('{Enter}')
    await waitFor(() => expect(field()).toHaveValue('C:\\Users\\you\\code\\'))
    // Home's rows are still up; Enter must not step into one of them.
    expect(rows()).toEqual(['code', 'Documents'])
    await user.keyboard('{Enter}')
    expect(field()).toHaveValue('C:\\Users\\you\\code\\')
  })

  it('reaches every folder of one too large to send whole by asking with the prefix', async () => {
    const user = userEvent.setup()
    const client = browsingClient({ startsIn: 'C:\\Users\\you\\code' })
    const browseFolders = client.commands.browseFolders
    const partial: EnvironmentClient = {
      ...client,
      commands: {
        ...client.commands,
        // The environment could only fit the first folder in its frame.
        browseFolders: async (path, prefix) => {
          const listing = await browseFolders(path, prefix)
          if (prefix !== undefined) return listing
          return { ...listing, entries: listing.entries.slice(0, 1), omitted: 2 }
        },
      },
    }
    render(<AddWorkspaceDialog client={partial} open onClose={() => undefined} />)
    await waitFor(() => expect(rows()).toEqual(['openmanager']))
    expect(screen.getByText(/2 more folders not shown/)).toBeInTheDocument()
    await user.type(field(), 'te')
    await waitFor(() => expect(rows()).toEqual(['tend']))
    expect(client.calls).toContainEqual({
      command: 'browseFolders',
      input: { path: 'C:\\Users\\you\\code\\', prefix: 'te' },
    })
  })

  it('cannot go above a drive root', async () => {
    render(
      <AddWorkspaceDialog
        client={browsingClient({ startsIn: 'C:\\' })}
        open
        onClose={() => undefined}
      />,
    )
    await waitFor(() => expect(field()).toHaveValue('C:\\'))
    expect(screen.getByRole('button', { name: 'Parent folder' })).toBeDisabled()
  })
})
