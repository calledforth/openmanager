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
import { ThemeProvider } from '@openmanager/app-core/providers/theme-provider'
import { TitleGenerationSettingControl, titleModelGroups } from './title-generation-setting'

// jsdom has no pointer capture, which the switch's drag uses.
HTMLElement.prototype.setPointerCapture ??= () => undefined
HTMLElement.prototype.releasePointerCapture ??= () => undefined
HTMLElement.prototype.hasPointerCapture ??= () => false

afterEach(() => {
  cleanup()
})

function renderSetting(client: EnvironmentClient) {
  return render(
    <ThemeProvider>
      <EnvironmentClientProvider client={client}>
        <TitleGenerationSettingControl
          section={(field) => (
            <section>
              <h2>Session titles</h2>
              {field}
            </section>
          )}
        />
      </EnvironmentClientProvider>
    </ThemeProvider>,
  )
}

const toggle = () => screen.getByRole('switch', { name: 'Generate titles' })
const chip = () => screen.getByRole('button', { name: /^Title model:/ })
const rows = () =>
  screen.queryAllByRole('option').map((row) => row.querySelector('.truncate')?.textContent)
const selectedTab = () =>
  document.querySelector('[role="tab"][aria-selected="true"]')?.textContent ?? ''

describe('title generation setting', () => {
  it("shows the environment's tool and model in the model picker", async () => {
    renderSetting(createMockEnvironmentClient())
    await waitFor(() => expect(toggle()).toHaveAttribute('aria-checked', 'true'))
    expect(chip()).toHaveAccessibleName('Title model: gpt-6-luna (default)')
  })

  it('picks another tool and model from the picker', async () => {
    const user = userEvent.setup()
    const client = createMockEnvironmentClient()
    renderSetting(client)
    await waitFor(() => expect(chip()).toBeEnabled())

    await user.click(chip())
    // The picker opens on the tool in use.
    await waitFor(() => expect(selectedTab()).toContain('Codex'))
    await user.click(screen.getByRole('tab', { name: /Claude/ }))
    expect(rows()).toContain('haiku (default)')
    await user.click(screen.getByRole('option', { name: /haiku \(default\)/ }))

    await waitFor(async () =>
      expect((await client.commands.getEnvironmentSettings()).titleGeneration).toEqual({
        provider: 'claude',
        model: '',
      }),
    )
  })

  it('takes a typed model id for a tool that lists none', async () => {
    const user = userEvent.setup()
    const client = createMockEnvironmentClient()
    renderSetting(client)
    await waitFor(() => expect(chip()).toBeEnabled())
    await user.click(chip())
    await user.keyboard('gpt-5.5')
    await user.keyboard('{Enter}')
    await waitFor(async () =>
      expect((await client.commands.getEnvironmentSettings()).titleGeneration).toEqual({
        provider: 'codex',
        model: 'gpt-5.5',
      }),
    )
    await waitFor(() => expect(chip()).toHaveAccessibleName('Title model: gpt-5.5'))
  })

  it('turns titles off and back on to the same choice', async () => {
    const user = userEvent.setup()
    const client = createMockEnvironmentClient({
      seed: { environmentSettings: { titleGeneration: { provider: 'claude', model: 'sonnet' } } },
    })
    renderSetting(client)
    await waitFor(() => expect(toggle()).toHaveAttribute('aria-checked', 'true'))

    await user.click(toggle())
    await waitFor(() => expect(toggle()).toHaveAttribute('aria-checked', 'false'))
    expect(screen.queryByRole('button', { name: /^Title model:/ })).toBeNull()
    expect((await client.commands.getEnvironmentSettings()).titleGeneration.provider).toBe('off')

    await user.click(toggle())
    await waitFor(() => expect(toggle()).toHaveAttribute('aria-checked', 'true'))
    expect((await client.commands.getEnvironmentSettings()).titleGeneration).toEqual({
      provider: 'claude',
      model: 'sonnet',
    })
  })

  it('offers no choice when the setting could not be read', async () => {
    const client = createMockEnvironmentClient()
    const failing: EnvironmentClient = {
      ...client,
      commands: {
        ...client.commands,
        getEnvironmentSettings: () =>
          Promise.reject(new Error('Environment settings unavailable.')),
      },
    }
    renderSetting(failing)
    expect(await screen.findByRole('alert')).toHaveTextContent('Environment settings unavailable.')
    expect(toggle()).toBeDisabled()
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

describe('titleModelGroups', () => {
  it('leads every tool with its title default and keeps a saved model no catalog lists', () => {
    const groups = titleModelGroups([], {}, { provider: 'cursor', model: 'auto' })
    expect(groups.map((group) => group.providerId)).toEqual([
      'claude',
      'cursor',
      'opencode',
      'codex',
    ])
    expect(groups[0]!.models[0]).toMatchObject({ id: '', name: 'haiku (default)' })
    expect(groups[1]!.models.map((model) => model.id)).toEqual(['', 'auto'])
  })

  it("lists a tool's session models only where its CLI takes the same ids", () => {
    const profiles = {
      claude: { availableModels: [{ modelId: 'opus', name: 'Opus' }] },
      // Cursor's sessions say `grok-4.7`; `cursor-agent --model` wants `grok-4.7-high`.
      cursor: { availableModels: [{ modelId: 'grok-4.7', name: 'Grok 4.7' }] },
    } as unknown as Parameters<typeof titleModelGroups>[1]
    const [claude, cursor, , codex] = titleModelGroups([], profiles, null)
    expect(claude!.models.map((model) => model.id)).toEqual(['', 'opus'])
    expect(claude!.acceptsTypedIds).toBeUndefined()
    expect(cursor!.models.map((model) => model.id)).toEqual([''])
    expect(cursor!.acceptsTypedIds).toBe(true)
    expect(codex!.acceptsTypedIds).toBe(true)
  })
})
