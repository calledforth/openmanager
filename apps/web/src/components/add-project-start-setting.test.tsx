import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import {
  EnvironmentClientError,
  WIRE_COMMANDS,
  createMockEnvironmentClient,
  type EnvironmentClient,
  type EnvironmentCommandName,
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

const field = () => screen.getByLabelText<HTMLInputElement>('Add project starts in')

describe('add project start setting', () => {
  it('shows the environment value and saves a change for every client', async () => {
    const user = userEvent.setup()
    const client = createMockEnvironmentClient({
      seed: { environmentSettings: { addProjectStartsIn: '~/code' } },
    })
    renderSetting(client)
    await waitFor(() => expect(field()).toHaveValue('~/code'))
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()

    await user.clear(field())
    await user.type(field(), '  ~/work  {Enter}')
    await waitFor(() => expect(field()).toHaveValue('~/work'))
    expect(await client.commands.getEnvironmentSettings()).toEqual({ addProjectStartsIn: '~/work' })
  })

  it('resets to the home folder', async () => {
    const user = userEvent.setup()
    const client = createMockEnvironmentClient({
      seed: { environmentSettings: { addProjectStartsIn: '~/code' } },
    })
    renderSetting(client)
    await user.click(await screen.findByRole('button', { name: 'Reset' }))
    await waitFor(() => expect(field()).toHaveValue(''))
    expect(screen.queryByRole('button', { name: 'Reset' })).not.toBeInTheDocument()
  })

  it('shows the environment refusal and keeps what was typed', async () => {
    const user = userEvent.setup()
    const client = createMockEnvironmentClient()
    const refusing: EnvironmentClient = {
      ...client,
      commands: {
        ...client.commands,
        setEnvironmentSettings: () =>
          Promise.reject(new EnvironmentClientError('validation', 'No folder exists at ~/nope.')),
      },
    }
    renderSetting(refusing)
    await waitFor(() => expect(field()).toBeEnabled())
    await user.type(field(), '~/nope{Enter}')
    expect(await screen.findByRole('alert')).toHaveTextContent('No folder exists at ~/nope.')
    expect(field()).toHaveValue('~/nope')
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
