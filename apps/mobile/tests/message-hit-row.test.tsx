// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { withoutLeadingEllipsis, type PlacedSearchHit } from '@openmanager/app-core/lib/chat-search'

import type { MessageHitRow as Hit } from '../src/home/message-search'
import type { HomeSession } from '../src/home/rows'

// The row as the search screen draws it, on react-native-web: the snippet
// cut into runs, the matched ones drawn apart, and whose words they are.
vi.mock('react-native', async () => {
  // @ts-expect-error -- react-native-web ships no types; it stands in for react-native here.
  return (await import('react-native-web')) as Record<string, unknown>
})
vi.mock('../src/theme/ThemeProvider', () => {
  const ink: Record<string, unknown> = new Proxy({}, { get: () => '#888888' })
  const theme = new Proxy(
    { fg: '#ffffff', muted: '#999999', faint: '#555555', hover: '#222222' },
    {
      get: (target: Record<string, unknown>, key: string) =>
        key === 'status' ? ink : key === 'wash' ? () => '#111111' : (target[key] ?? '#888888'),
    },
  )
  return { usePhoneTheme: () => theme }
})
vi.mock('../src/ui/StatusMark', () => ({ StatusMark: () => <i data-mark /> }))
vi.mock('../src/ui/ProjectChip', () => ({
  ProjectChip: ({ name }: { name: string }) => <span data-project>{name}</span>,
}))
vi.mock('../src/ui/haptics', () => ({ tap: () => undefined }))
vi.mock('phosphor-react-native', () => ({
  HardDrivesIcon: () => <i data-icon="drives" />,
  PencilSimpleLineIcon: () => <i />,
  PushPinIcon: () => <i />,
}))

const { MessageHitRow } = await import('../src/ui/MessageHitRow')

let container: HTMLDivElement
let root: Root
const render = async (node: ReactNode) => {
  await act(async () => root.render(node))
}
const text = () => container.textContent ?? ''

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const SESSION: HomeSession = {
  externalId: 's1',
  title: 'Fix the reconnect loop',
  status: 'ready',
  providerId: 'claude',
  isDriven: true,
  settledAt: null,
  workspacePath: 'C:/repo',
  environment: { environmentId: 'env-desk', label: 'Desk' },
}

const row = (patch: Partial<PlacedSearchHit> = {}): Hit => {
  const hit: PlacedSearchHit = {
    environmentId: 'env-desk',
    sessionId: 's1',
    workspaceId: 'w',
    title: 'Fix the reconnect loop',
    messageId: 'm1',
    role: 'assistant',
    at: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    snippet: '… the socket drops and the reconnect loop spins',
    highlights: [
      [6, 12],
      [27, 36],
    ],
    matches: 2,
    ...patch,
  }
  return {
    key: 'env-desk\ns1',
    row: {
      kind: 'session',
      session: SESSION,
      workspace: { path: 'C:/repo', name: 'repo', availability: 'available' },
      mark: 'idle',
      depth: 0,
    },
    hit,
    snippet: withoutLeadingEllipsis(hit),
  }
}

const matches = () =>
  [...container.querySelectorAll('[data-testid="snippet-match"]')].map((node) => node.textContent)

describe('message hit row', () => {
  it('draws the matched runs apart, in order, and the rest as plain text', async () => {
    await render(<MessageHitRow hit={row()} />)
    expect(matches()).toEqual(['socket', 'reconnect'])
    expect(text()).toContain('the socket drops and the reconnect loop spins')
    // The leading "…" is gone.
    expect(text()).not.toContain('…')
    expect(text()).toContain('Fix the reconnect loop')
    expect(text()).toContain('repo')
    expect(text()).toContain('2h')
  })

  it('says "You: " before the reader’s own words only', async () => {
    await render(<MessageHitRow hit={row({ role: 'user' })} />)
    expect(text()).toContain('You: the socket drops')
    await render(<MessageHitRow hit={row()} />)
    expect(text()).not.toContain('You:')
  })

  it('names the environment only when asked to', async () => {
    await render(<MessageHitRow hit={row()} />)
    expect(text()).not.toContain('Desk')
    await render(<MessageHitRow hit={row()} showEnvironment />)
    expect(text()).toContain('Desk')
  })

  it('opens on a press', async () => {
    const onPress = vi.fn()
    await render(<MessageHitRow hit={row()} onPress={onPress} />)
    const button = container.querySelector<HTMLElement>('[role="button"]')!
    await act(async () => {
      button.click()
    })
    expect(onPress).toHaveBeenCalledTimes(1)
  })
})
