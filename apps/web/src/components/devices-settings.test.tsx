import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  EnvironmentClientError,
  createMockEnvironmentClient,
  type AuthorizedClient,
  type EnvironmentClient,
} from '@openmanager/environment-client'
import { EnvironmentClientProvider } from '@openmanager/app-core/providers/environment-client'
import {
  DevicesSettingControl,
  describeAccess,
  describePresence,
  omittedNote,
} from './devices-settings'

afterEach(() => {
  cleanup()
})

const NOW = Date.parse('2026-10-02T12:00:00.000Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()

const owner: AuthorizedClient = {
  clientId: 'client-owner',
  label: 'Local owner',
  kind: 'owner',
  capabilities: ['read', 'operate', 'agent', 'terminal', 'admin'],
  createdAt: ago(86_400_000 * 30),
  lastSeenAt: ago(1_000),
  expiresAt: ago(-86_400_000 * 30),
  connected: true,
}
const phone: AuthorizedClient = {
  ...owner,
  clientId: 'client-phone',
  label: 'Phone',
  kind: 'paired',
  capabilities: ['read', 'operate'],
  lastSeenAt: ago(3 * 3_600_000),
  connected: false,
}
const tablet: AuthorizedClient = {
  ...phone,
  clientId: 'client-tablet',
  label: 'Tablet',
  capabilities: ['read'],
  lastSeenAt: null,
}

function mockClient(currentClientId = 'client-owner', clients = [owner, phone, tablet]) {
  return createMockEnvironmentClient({
    seed: { authorizedClients: clients, currentClientId },
  })
}

function renderDevices(client: EnvironmentClient | null, onCredentialRotated = vi.fn()) {
  render(
    <EnvironmentClientProvider client={client}>
      <DevicesSettingControl
        section={(body) => (
          <section>
            <h2>Devices</h2>
            {body}
          </section>
        )}
        onCredentialRotated={onCredentialRotated}
      />
    </EnvironmentClientProvider>,
  )
  return { onCredentialRotated }
}

/** The dialog has finished closing, and the page behind it is readable again. */
const dialogGone = () =>
  waitFor(() => expect(screen.queryByRole('dialog', { hidden: true })).toBeNull(), {
    timeout: 3_000,
  })

const row = (name: string) => screen.getByRole('listitem', { name })

describe('device descriptions', () => {
  it('says when a device was seen and what it may do', () => {
    expect(describePresence(owner, NOW)).toBe('Online now')
    expect(describePresence(phone, NOW)).toBe('Last seen 3h ago')
    expect(describePresence(tablet, NOW)).toBe('Never connected')
    expect(describeAccess(owner.capabilities)).toBe('Full access')
    expect(describeAccess(['admin', 'read'])).toBe('View, Manage access')
  })

  it('says what the list leaves out, and what revoking the others reaches', () => {
    expect(omittedNote(3, false)).toBe(
      '3 more devices, the least recently seen, are not shown. Revoking all other devices reaches them too.',
    )
    expect(omittedNote(3, true)).toBe(
      '3 more devices, the least recently seen, are not shown, this one among them. Revoking all other devices reaches the rest.',
    )
    expect(omittedNote(1, true)).toBe(
      '1 more device, the least recently seen, is not shown: this one.',
    )
  })
})

describe('devices settings', () => {
  it('asks for an environment when none is connected', () => {
    renderDevices(null)
    expect(screen.getByText(/Connect to an environment/)).toBeInTheDocument()
  })

  it('lists the devices with this device and the owner marked', async () => {
    const client = mockClient()
    client.connect()
    renderDevices(client)
    await waitFor(() => expect(screen.getByRole('list', { name: 'Devices' })).toBeInTheDocument())
    const items = within(screen.getByRole('list', { name: 'Devices' })).getAllByRole('listitem')
    expect(items.map((item) => item.getAttribute('aria-label'))).toEqual([
      'Local owner',
      'Phone',
      'Tablet',
    ])
    expect(within(row('Local owner')).getByText('This device')).toBeInTheDocument()
    expect(within(row('Local owner')).getByText('Owner')).toBeInTheDocument()
    expect(within(row('Local owner')).getByText(/Online now · Full access/)).toBeInTheDocument()
    expect(within(row('Tablet')).getByText(/Never connected · View/)).toBeInTheDocument()
    // Neither the owner nor this device offers a revoke.
    expect(within(row('Local owner')).queryByRole('button', { name: /Revoke/ })).toBeNull()
    expect(within(row('Phone')).getByRole('button', { name: 'Revoke Phone' })).toBeEnabled()
  })

  it('renames a device in place, trimming the name, and Escape cancels', async () => {
    const user = userEvent.setup()
    const client = mockClient()
    client.connect()
    renderDevices(client)
    await user.click(await screen.findByRole('button', { name: 'Rename Phone' }))
    const field = screen.getByRole('textbox', { name: 'Device name' })
    expect(field).toHaveFocus()
    await user.clear(field)
    await user.type(field, '  Pixel  {Enter}')
    await waitFor(() => expect(row('Pixel')).toBeInTheDocument())
    expect((await client.commands.listAuthorizedClients()).clients[1]!.label).toBe('Pixel')

    await user.click(screen.getByRole('button', { name: 'Rename Pixel' }))
    await user.type(screen.getByRole('textbox', { name: 'Device name' }), 'x{Escape}')
    expect(screen.queryByRole('textbox', { name: 'Device name' })).toBeNull()
    expect(row('Pixel')).toBeInTheDocument()
  })

  it('revokes a device only after confirming', async () => {
    const user = userEvent.setup()
    const client = mockClient()
    client.connect()
    renderDevices(client)
    await user.click(await screen.findByRole('button', { name: 'Revoke Phone' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Revoke Phone?')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await dialogGone()
    expect(row('Phone')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Revoke Phone' }))
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Revoke' }),
    )
    await dialogGone()
    expect(screen.queryByRole('listitem', { name: 'Phone', hidden: true })).toBeNull()
    expect((await client.commands.listAuthorizedClients()).clients.map((c) => c.label)).toEqual([
      'Local owner',
      'Tablet',
    ])
  })

  it('revokes every other device, keeping this one and the owner', async () => {
    const user = userEvent.setup()
    const client = mockClient('client-phone', [
      owner,
      { ...phone, capabilities: ['read', 'admin'] },
      tablet,
    ])
    client.connect()
    renderDevices(client)
    await user.click(await screen.findByRole('button', { name: 'Revoke all other devices' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/1 device loses access now/)).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Revoke all' }))
    await dialogGone()
    expect(screen.queryByRole('listitem', { name: 'Tablet', hidden: true })).toBeNull()
    expect(row('Local owner')).toBeInTheDocument()
    expect(row('Phone')).toBeInTheDocument()
    // A paired device cannot rotate the owner, and nothing is left to revoke.
    expect(screen.queryByRole('button', { name: 'Rotate credential' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Revoke all other devices' })).toBeNull()
  })

  it('says how many devices the list leaves out', async () => {
    const client = mockClient()
    client.connect()
    vi.spyOn(client.commands, 'listAuthorizedClients').mockResolvedValue({
      clients: [owner, phone],
      currentClientId: 'client-owner',
      omitted: 3,
    })
    renderDevices(client)
    expect(await screen.findByText(/3 more devices, the least recently seen/)).toBeInTheDocument()
  })

  it('does not count this device among the others when the list leaves it out', async () => {
    const user = userEvent.setup()
    const client = mockClient('client-tablet', [
      owner,
      phone,
      { ...tablet, capabilities: ['read', 'admin'] },
    ])
    client.connect()
    vi.spyOn(client.commands, 'listAuthorizedClients').mockResolvedValue({
      clients: [owner, phone],
      currentClientId: 'client-tablet',
      omitted: 2,
    })
    renderDevices(client)
    await user.click(await screen.findByRole('button', { name: 'Revoke all other devices' }))
    // Phone, plus one omitted device that is not this one.
    expect(await screen.findByText(/2 devices lose access now/)).toBeInTheDocument()
  })

  it('refuses everything to a device without admin, as the environment would', async () => {
    const client = mockClient('client-tablet')
    await expect(client.commands.listAuthorizedClients()).rejects.toMatchObject({
      code: 'capability_missing',
    })
    await expect(client.commands.revokeAuthorizedClient('client-phone')).rejects.toMatchObject({
      code: 'capability_missing',
    })
  })

  it('keeps the confirm open with the reason when a revoke fails', async () => {
    const user = userEvent.setup()
    const client = mockClient()
    client.connect()
    vi.spyOn(client.commands, 'revokeAuthorizedClient').mockRejectedValue(
      new EnvironmentClientError('unavailable', 'The environment did not answer.'),
    )
    renderDevices(client)
    await user.click(await screen.findByRole('button', { name: 'Revoke Phone' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Revoke' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'The environment did not answer.',
    )
    expect(within(dialog).getByRole('button', { name: 'Revoke' })).toBeEnabled()
  })

  it('offers no rotation, and no owner rename, to a paired device', async () => {
    const client = mockClient('client-phone', [
      owner,
      { ...phone, capabilities: ['read', 'admin'] },
      tablet,
    ])
    client.connect()
    renderDevices(client)
    await screen.findByRole('listitem', { name: 'Tablet' })
    expect(within(row('Local owner')).queryByRole('button')).toBeNull()
    expect(within(row('Phone')).getByRole('button', { name: 'Rename Phone' })).toBeEnabled()
  })

  it('offers no rotation where there is nowhere to keep a new credential', async () => {
    const client = mockClient()
    client.connect()
    render(
      <EnvironmentClientProvider client={client}>
        <DevicesSettingControl section={(body) => <section>{body}</section>} />
      </EnvironmentClientProvider>,
    )
    await screen.findByRole('listitem', { name: 'Tablet' })
    expect(screen.queryByRole('button', { name: 'Rotate credential' })).toBeNull()
  })

  it('rotates the owner credential and hands the new one over to be saved', async () => {
    const user = userEvent.setup()
    const client = mockClient()
    client.connect()
    const { onCredentialRotated } = renderDevices(client)
    await user.click(await screen.findByRole('button', { name: 'Rotate credential' }))
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Rotate' }),
    )
    await waitFor(() => expect(onCredentialRotated).toHaveBeenCalledWith(`omc1.${'m'.repeat(43)}`))
  })

  it('follows changes another device makes', async () => {
    const client = mockClient()
    client.connect()
    renderDevices(client)
    await screen.findByRole('listitem', { name: 'Tablet' })
    await client.commands.renameAuthorizedClient('client-tablet', 'Kitchen display')
    await waitFor(() => expect(row('Kitchen display')).toBeInTheDocument())
  })

  it('tells a device without admin that it cannot manage access', async () => {
    const client = mockClient()
    client.connect()
    vi.spyOn(client.commands, 'listAuthorizedClients').mockRejectedValue(
      new EnvironmentClientError(
        'capability_missing',
        'This command requires the admin capability.',
      ),
    )
    renderDevices(client)
    expect(await screen.findByText(/This device cannot manage access/)).toBeInTheDocument()
  })
})
