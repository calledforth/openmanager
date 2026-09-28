import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import {
  WIRE_COMMANDS,
  createMockEnvironmentClient,
  type EnvironmentClient,
  type EnvironmentCommandName,
} from '@openmanager/environment-client'
import { EnvironmentClientProvider } from '@openmanager/app-core/providers/environment-client'
import { TITLE_GENERATION_CHOICES, TitleGenerationSettingControl } from './title-generation-setting'

afterEach(() => {
  cleanup()
})

function renderSetting(client: EnvironmentClient) {
  return render(
    <EnvironmentClientProvider client={client}>
      <TitleGenerationSettingControl
        section={(field) => (
          <section>
            <h2>Session titles</h2>
            {field}
          </section>
        )}
        choices={(value, onChange, disabled) => (
          <div role="radiogroup" aria-label="Session titles">
            {TITLE_GENERATION_CHOICES.map((choice) => (
              <label key={choice.id}>
                <input
                  type="radio"
                  name="title-generation"
                  checked={value === choice.id}
                  disabled={disabled}
                  onChange={() => onChange(choice.id)}
                />
                {choice.label}
              </label>
            ))}
          </div>
        )}
      />
    </EnvironmentClientProvider>,
  )
}

const modelField = () => screen.getByLabelText<HTMLInputElement>('Title model')

describe('title generation setting', () => {
  it("shows the environment's tool, with its default model as the hint", async () => {
    const client = createMockEnvironmentClient()
    renderSetting(client)
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Codex' })).toBeChecked())
    expect(modelField()).toHaveValue('')
    expect(modelField()).toHaveAttribute('placeholder', 'gpt-6-luna')
  })

  it('switches tool on the default model and saves a model override', async () => {
    const user = userEvent.setup()
    const client = createMockEnvironmentClient({
      seed: { environmentSettings: { titleGeneration: { provider: 'codex', model: 'gpt-x' } } },
    })
    renderSetting(client)
    await waitFor(() => expect(modelField()).toHaveValue('gpt-x'))

    await user.click(screen.getByRole('radio', { name: 'Claude Code' }))
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Claude Code' })).toBeChecked())
    expect(modelField()).toHaveValue('')
    expect(modelField()).toHaveAttribute('placeholder', 'haiku')

    await user.type(modelField(), ' sonnet {Enter}')
    await waitFor(() => expect(modelField()).toHaveValue('sonnet'))
    expect((await client.commands.getEnvironmentSettings()).titleGeneration).toEqual({
      provider: 'claude',
      model: 'sonnet',
    })
  })

  it('hides the model when titles are off', async () => {
    const user = userEvent.setup()
    const client = createMockEnvironmentClient()
    renderSetting(client)
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Off' })).toBeEnabled())
    await user.click(screen.getByRole('radio', { name: 'Off' }))
    await waitFor(() => expect(screen.queryByLabelText('Title model')).not.toBeInTheDocument())
    expect((await client.commands.getEnvironmentSettings()).titleGeneration.provider).toBe('off')
  })

  it('offers no choice when the setting could not be read', async () => {
    const client = createMockEnvironmentClient()
    const failing: EnvironmentClient = {
      ...client,
      commands: {
        ...client.commands,
        getEnvironmentSettings: () => Promise.reject(new Error('Environment settings unavailable.')),
      },
    }
    renderSetting(failing)
    expect(await screen.findByRole('alert')).toHaveTextContent('Environment settings unavailable.')
    for (const radio of screen.getAllByRole('radio')) expect(radio).toBeDisabled()
  })

  it('draws nothing for an environment without settings', () => {
    const client = createMockEnvironmentClient({
      capabilities: (Object.keys(WIRE_COMMANDS) as EnvironmentCommandName[]).filter(
        (command) => command !== 'getEnvironmentSettings',
      ),
    })
    renderSetting(client)
    expect(screen.queryByText('Session titles')).not.toBeInTheDocument()
  })
})
