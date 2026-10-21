/**
 * A realistic environment for building the shell before the phone talks to
 * one: the titles and projects are the owner's own (lifted from the mockups),
 * the shapes are the shared sidebar entries. Replaced by the environment
 * providers in the sessions-list issue; nothing here reaches a server.
 */
import type { WorkspaceEntry } from '@openmanager/app-core/providers/sidebar-provider'

import type { HomeDraft, HomeSession } from './rows'

const minutesAgo = (minutes: number, now = Date.now()) =>
  new Date(now - minutes * 60_000).toISOString()

export interface FixtureEnvironment {
  environmentId: string
  label: string
  route: { kind: 'local' | 'tunnel'; address: string; latencyMs: number }
}

export const FIXTURE_ENVIRONMENT: FixtureEnvironment = {
  environmentId: 'env-desktop',
  label: "Cletus's desktop",
  route: { kind: 'local', address: '192.168.1.4:43120', latencyMs: 12 },
}

export const FIXTURE_WORKSPACES: WorkspaceEntry[] = [
  {
    path: 'C:/Users/rajku/OneDrive/Documents/ClePro/openmanager',
    name: 'openmanager',
    availability: 'available',
    lastActivityAt: minutesAgo(0),
    git: { branch: 'dev', worktree: false },
  },
  {
    path: 'C:/Users/rajku/OneDrive/Documents/ClePro/salesmaxai',
    name: 'salesmaxai',
    availability: 'available',
    lastActivityAt: minutesAgo(70),
    git: { branch: 'main', worktree: false },
  },
  {
    path: 'C:/Users/rajku/OneDrive/Documents/ClePro',
    name: 'ClePro',
    availability: 'available',
    lastActivityAt: minutesAgo(60 * 26),
  },
  {
    path: 'C:/Users/rajku/.tmp/t3code',
    name: 't3code',
    availability: 'missing',
    lastActivityAt: minutesAgo(60 * 24 * 9),
  },
]

const [OPENMANAGER, SALESMAXAI, CLEPRO, T3CODE] = FIXTURE_WORKSPACES as [
  WorkspaceEntry,
  WorkspaceEntry,
  WorkspaceEntry,
  WorkspaceEntry,
]

export const FIXTURE_SESSIONS: HomeSession[] = [
  {
    externalId: 's-tool-payloads',
    title: 'Codex Integration: Tool Call Payloads',
    status: 'running',
    providerId: 'claude',
    isDriven: false,
    workspacePath: OPENMANAGER.path,
    updatedAt: minutesAgo(0),
  },
  {
    externalId: 's-tool-payloads-tests',
    title: 'Contract tests for turn_activity',
    status: 'running',
    providerId: 'claude',
    isDriven: true,
    parentExternalId: 's-tool-payloads',
    workspacePath: OPENMANAGER.path,
    updatedAt: minutesAgo(1),
  },
  {
    externalId: 's-settings-redesign',
    title: 'Settings Environment Page Redesign',
    status: 'waiting',
    waitingOn: 'permission',
    providerId: 'claude',
    isDriven: false,
    workspacePath: OPENMANAGER.path,
    updatedAt: minutesAgo(4),
  },
  {
    externalId: 's-soul-id',
    title: 'Higgsfield Soul ID API Automation',
    status: 'waiting',
    waitingOn: 'question',
    providerId: 'opencode',
    isDriven: false,
    workspacePath: CLEPRO.path,
    updatedAt: minutesAgo(12),
  },
  {
    externalId: 's-mcp-server',
    title: 'MCP server for the ticket queue',
    status: 'running',
    inBackground: true,
    backgroundTaskCount: 2,
    backgroundTaskNames: 'vitest --watch\ndev server',
    providerId: 'opencode',
    isDriven: false,
    workspacePath: OPENMANAGER.path,
    updatedAt: minutesAgo(18),
  },
  {
    externalId: 's-pricing',
    title: 'Pricing page copy, three tiers',
    status: 'idle',
    providerId: 'opencode',
    isDriven: false,
    workspacePath: SALESMAXAI.path,
    updatedAt: minutesAgo(70),
    doneUnseen: true,
  },
  {
    externalId: 's-sync-f2',
    title: 'Sync foundations: convergence harness',
    status: 'error',
    providerId: 'claude',
    isDriven: false,
    workspacePath: OPENMANAGER.path,
    updatedAt: minutesAgo(60 * 3),
  },
  {
    externalId: 's-portfolio',
    title: 'Freelancer Portfolio Site',
    status: 'idle',
    providerId: 'cursor',
    isDriven: false,
    workspacePath: CLEPRO.path,
    updatedAt: minutesAgo(60 * 26),
  },
  {
    externalId: 's-grouped-themes',
    title: 'Group themes into families',
    status: 'idle',
    providerId: 'claude',
    isDriven: false,
    workspacePath: OPENMANAGER.path,
    updatedAt: minutesAgo(60 * 24 * 2),
    settledAt: minutesAgo(60 * 24),
  },
  {
    externalId: 's-send-flicker',
    title: 'Stop a sent message from flickering',
    status: 'idle',
    providerId: 'claude',
    isDriven: false,
    workspacePath: OPENMANAGER.path,
    updatedAt: minutesAgo(60 * 24 * 3),
    settledAt: minutesAgo(60 * 24 * 2),
  },
  {
    externalId: 's-t3code',
    title: 'Read t3code as a security reference',
    status: 'idle',
    providerId: 'claude',
    isDriven: false,
    workspacePath: T3CODE.path,
    workspaceUnavailable: true,
    updatedAt: minutesAgo(60 * 24 * 9),
    settledAt: minutesAgo(60 * 24 * 8),
  },
]

export const FIXTURE_DRAFTS: HomeDraft[] = [
  {
    draftId: 'd-upload-retry',
    workspacePath: OPENMANAGER.path,
    preview: 'Add a retry to the upload ticket when the socket drops mid-PUT',
    updatedAt: minutesAgo(2),
    providerLabel: 'Opus 5.5 · Agent',
    synced: true,
  },
  {
    draftId: 'd-pricing',
    workspacePath: SALESMAXAI.path,
    preview: 'Write the landing copy for the pricing page, three tiers',
    updatedAt: minutesAgo(60),
    providerLabel: 'GPT-6.1 · Plan',
    synced: true,
  },
  {
    draftId: 'd-sidebar-remount',
    workspacePath: OPENMANAGER.path,
    preview: 'Why does the sidebar remount when the theme flips?',
    updatedAt: minutesAgo(60 * 3),
    synced: false,
  },
  {
    draftId: 'd-soul-avatar',
    workspacePath: CLEPRO.path,
    preview: 'Match this reference — the soul ID avatar grid',
    updatedAt: minutesAgo(60 * 25),
    providerLabel: 'Cursor',
    synced: true,
    imageCount: 2,
  },
]
