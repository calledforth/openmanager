import type { Meta, StoryObj } from '@storybook/react-vite'
import { useEffect, useMemo } from 'react'
import {
  createMockEnvironmentClient,
  selectDraftContent,
  type MockEnvironmentClient,
  type ProviderCatalogEntry,
} from '@openmanager/environment-client'
import type { Workspace } from '@openmanager/protocol'
import { ThemeProvider } from '../../providers/theme-provider'
import { EnvironmentClientProvider } from '../../providers/environment-client'
import { EnvironmentApplicationProviders } from '../../providers/environment-application'
import {
  QuickAgentHost,
  QuickAgentPalette,
  requestQuickAgent,
  useQuickAgentOpen,
  type QuickAgentEnvironments,
} from '../../components/command/QuickAgentPalette'

const project = (name: string, hoursAgo: number): Workspace => ({
  workspaceId: `/home/you/code/${name}`,
  name,
  path: `/home/you/code/${name}`,
  lastUsedAt: null,
  lastActivityAt: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(),
  capabilities: { git: true },
  exists: true,
})

const CLAUDE: ProviderCatalogEntry = {
  id: 'claude',
  displayName: 'Claude',
  capabilities: {
    canSetModel: true,
    canSetMode: true,
    canSetConfigOption: true,
    canDeleteSession: false,
    canLoadSession: true,
    canListSessions: true,
    canCancelPrompt: true,
    canSteer: true,
    supportsPlans: false,
    supportsAvailableCommands: false,
    supportsUsage: false,
    supportsPermissionRequests: true,
    supportsAuthentication: false,
    supportsThoughtStreaming: false,
    supportsSubtasks: false,
    supportsExtensions: false,
    supportsQuestions: false,
  },
  health: {
    summary: 'ready',
    available: true,
    refreshing: false,
    install: 'installed',
    auth: 'authenticated',
    runtime: { state: 'running', liveProcesses: 1, activeTurns: 0 },
    lastProbe: null,
    update: 'current',
  },
  limits: { supported: false, reading: null, refreshing: false, lastRefresh: null },
  profile: {
    providerId: 'claude',
    availableModels: [
      { modelId: 'opus', name: 'Opus 4.5' },
      { modelId: 'sonnet', name: 'Sonnet 4.5' },
    ],
    defaultModelId: 'opus',
    updatedAt: 1_700_000_000_000,
  },
}

/** A saved new-session draft, as if written a while ago. */
function seedDraft(client: MockEnvironmentClient, id: string, workspaceId: string, text: string) {
  client.drafts!.edit(
    id,
    { type: 'new_session', workspaceId, sessionId: `${id}-session` },
    { text, providerId: 'claude' },
  )
}

function useEnvironments() {
  return useMemo(() => {
    const wsl = createMockEnvironmentClient({
      seed: {
        environment: { environmentId: 'wsl', name: 'WSL' },
        workspaces: [project('openmanager', 1), project('website', 6)],
        providers: [CLAUDE],
      },
    })
    const mac = createMockEnvironmentClient({
      seed: {
        environment: { environmentId: 'mac', name: 'MacBook' },
        workspaces: [project('infra', 2)],
        providers: [CLAUDE],
      },
    })
    seedDraft(
      wsl,
      'flicker',
      '/home/you/code/openmanager',
      'Fix the drafts sidebar flicker when a send fails halfway through',
    )
    seedDraft(
      wsl,
      'pricing',
      '/home/you/code/website',
      'Rewrite the pricing page hero, keep it under 12 words',
    )
    seedDraft(mac, 'node', '/home/you/code/infra', 'Bump node to 22 in the CI image')
    const clients: Record<string, MockEnvironmentClient> = { wsl, mac }
    const environments: QuickAgentEnvironments = {
      environments: [
        { environmentId: 'wsl', label: 'WSL', platform: 'wsl', reachable: true },
        { environmentId: 'mac', label: 'MacBook', platform: 'macos', reachable: true },
        { environmentId: 'cloud', label: 'Cloud box', platform: 'linux', reachable: false },
      ],
      clientOf: (environmentId) => clients[environmentId],
      // The web app's carry copies through the environment choice; here, plainly.
      carry: (environmentId, from) => {
        const target = clients[environmentId]
        const source = clients[from.environmentId]
        if (!target || !source) return false
        const text = selectDraftContent(source.getState(), from.draftId)?.text ?? ''
        const workspaceId = target.getState().workspaceOrder[0] ?? null
        const copy = { draftId: crypto.randomUUID(), sessionId: crypto.randomUUID(), workspaceId }
        if (text.trim()) {
          target.drafts!.edit(
            copy.draftId,
            { type: 'new_session', workspaceId, sessionId: copy.sessionId },
            { text },
          )
          source.drafts!.discard(from.draftId)
        }
        return copy
      },
      openDraft: () => undefined,
      openSession: () => undefined,
      openNewSession: () => undefined,
    }
    return { clients, environments }
  }, [])
}

/** The card for a draft moved to an environment the page is not on. */
function Elsewhere({ clients }: { clients: Record<string, MockEnvironmentClient> }) {
  const open = useQuickAgentOpen()
  const environmentId = open?.environmentId
  const client = environmentId && environmentId !== 'wsl' ? clients[environmentId] : undefined
  if (!client || !environmentId) return null
  return (
    <EnvironmentClientProvider key={environmentId} client={client}>
      <EnvironmentApplicationProviders environmentId={environmentId}>
        <QuickAgentPalette environmentId={environmentId} primary={false} />
      </EnvironmentApplicationProviders>
    </EnvironmentClientProvider>
  )
}

function OpensOnMount() {
  useEffect(() => {
    const timer = setTimeout(() => requestQuickAgent(), 50)
    return () => clearTimeout(timer)
  }, [])
  return null
}

function QuickAgentDemo() {
  const { clients, environments } = useEnvironments()
  return (
    <ThemeProvider>
      <QuickAgentHost environments={environments}>
        <EnvironmentClientProvider client={clients.wsl!}>
          <EnvironmentApplicationProviders environmentId="wsl">
            <div className="flex h-svh items-start justify-center bg-background p-8 text-[13px] text-muted-foreground">
              Press N, or ⌘⇧O, for a new agent.
            </div>
            <QuickAgentPalette environmentId="wsl" />
            <OpensOnMount />
          </EnvironmentApplicationProviders>
        </EnvironmentClientProvider>
        <Elsewhere clients={clients} />
      </QuickAgentHost>
    </ThemeProvider>
  )
}

const meta = {
  title: 'App/QuickAgentPalette',
  parameters: { layout: 'fullscreen' },
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

/** Two environments with drafts on each, and one that is not connected. */
export const DraftsAndEnvironments: Story = { render: () => <QuickAgentDemo /> }
