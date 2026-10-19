import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import {
  EnvironmentClientError,
  WIRE_COMMANDS,
  createMockEnvironmentClient,
  type EnvironmentClient,
  type EnvironmentCommandName,
  type MockEnvironmentClientOptions,
} from '@openmanager/environment-client'
import { EnvironmentClientProvider } from '@openmanager/app-core/providers/environment-client'
import { AddProjectStartSetting } from './add-project-start-setting'

afterEach(() => {
  cleanup()
})

function renderSetting(client: EnvironmentClient) {
  return render(
    <EnvironmentClientProvider client={client}>
      <AddProjectStartSetting
        section={(field) => (
          <section>
            <h2>Add project starts in</h2>
            {field}
          </section>
        )}
      />
    </EnvironmentClientProvider>,
  )
}

const FOLDERS = {
  '/home/me': ['code', 'work'],
  '/home/me/code': ['openmanager'],
  '/home/me/code/openmanager': [],
  '/home/me/work': [],
}

const browsingClient = (startsIn = '', options: MockEnvironmentClientOptions = {}) =>
  createMockEnvironmentClient({
    ...options,
    seed: {
      folders: FOLDERS,
      home: '/home/me',
      environmentSettings: { addProjectStartsIn: startsIn },
    },
  })

const folderButton = () => screen.getByRole('button', { name: /^Add project starts in/ })
const rows = () => screen.queryAllByRole('option').map((row) => row.textContent)

describe('add project start setting', () => {
  it('shows the home folder by its real path when nothing is set', async () => {
    renderSetting(browsingClient())
    await waitFor(() => expect(folderButton()).toHaveTextContent('/home/me'))
    expect(folderButton()).toHaveTextContent('Home')
    expect(screen.queryByRole('button', { name: 'Start in the home folder' })).toBeNull()
  })

  it('picks the folder in the same browser Add project uses', async () => {
    const user = userEvent.setup()
    const client = browsingClient()
    renderSetting(client)
    await waitFor(() => expect(folderButton()).toBeEnabled())
    await user.click(folderButton())

    const dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(rows()).toEqual(['code', 'work']))
    await user.click(within(dialog).getByRole('option', { name: /code/ }))
    await waitFor(() => expect(rows()).toEqual(['openmanager']))
    await user.click(within(dialog).getByRole('button', { name: /Start in code/ }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(folderButton()).toHaveTextContent('/home/me/code')
    expect(folderButton()).not.toHaveTextContent('Home')
    expect(await client.commands.getEnvironmentSettings()).toMatchObject({
      addProjectStartsIn: '/home/me/code',
    })
  })

  it('opens the browser where the setting points, and resets to home', async () => {
    const user = userEvent.setup()
    const client = browsingClient('/home/me/code')
    renderSetting(client)
    await waitFor(() => expect(folderButton()).toHaveTextContent('/home/me/code'))

    await user.click(folderButton())
    await waitFor(() => expect(rows()).toEqual(['openmanager']))
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: 'Start in the home folder' }))
    await waitFor(() => expect(folderButton()).toHaveTextContent('Home'))
    expect(folderButton()).toHaveTextContent('/home/me')
    expect((await client.commands.getEnvironmentSettings()).addProjectStartsIn).toBe('')
  })

  it('shows the environment refusal inside the browser and keeps it open', async () => {
    const user = userEvent.setup()
    const client = browsingClient()
    const refusing: EnvironmentClient = {
      ...client,
      commands: {
        ...client.commands,
        setEnvironmentSettings: () =>
          Promise.reject(new EnvironmentClientError('validation', 'That folder is gone.')),
      },
    }
    renderSetting(refusing)
    await waitFor(() => expect(folderButton()).toBeEnabled())
    await user.click(folderButton())
    const dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(rows()).toEqual(['code', 'work']))
    await user.click(within(dialog).getByRole('button', { name: /Start in me/ }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('That folder is gone.')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  describe('on an environment that cannot list folders', () => {
    const typedClient = (startsIn = '') =>
      createMockEnvironmentClient({
        capabilities: (Object.keys(WIRE_COMMANDS) as EnvironmentCommandName[]).filter(
          (command) => command !== 'browseFolders',
        ),
        seed: { environmentSettings: { addProjectStartsIn: startsIn } },
      })
    const field = () => screen.getByLabelText<HTMLInputElement>('Add project starts in')

    it('takes a typed path instead', async () => {
      const user = userEvent.setup()
      const client = typedClient('~/code')
      renderSetting(client)
      await waitFor(() => expect(field()).toHaveValue('~/code'))
      await user.clear(field())
      await user.type(field(), '  ~/work  {Enter}')
      await waitFor(() => expect(field()).toHaveValue('~/work'))
      expect(await client.commands.getEnvironmentSettings()).toMatchObject({
        addProjectStartsIn: '~/work',
      })
    })
  })

  it('draws nothing for an environment without the setting', () => {
    const client = createMockEnvironmentClient({
      capabilities: (Object.keys(WIRE_COMMANDS) as EnvironmentCommandName[]).filter(
        (command) => command !== 'getEnvironmentSettings',
      ),
    })
    renderSetting(client)
    expect(screen.queryByText('Add project starts in')).not.toBeInTheDocument()
  })
})
