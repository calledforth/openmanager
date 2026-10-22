/**
 * A realistic environment for showing the shell without a server: the titles
 * and projects are the owner's own (lifted from the mockups), the shapes are
 * the shared sidebar entries. The home reads it only on a phone with nothing
 * paired, and only when the build sets `EXPO_PUBLIC_FIXTURE=1`
 * (`source.ts`); nothing here reaches a server.
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
    // Finished since anyone looked: the environment says `done` until it is opened.
    status: 'done',
    providerId: 'opencode',
    isDriven: false,
    workspacePath: SALESMAXAI.path,
    updatedAt: minutesAgo(70),
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
    status: 'ready',
    providerId: 'cursor',
    isDriven: false,
    workspacePath: CLEPRO.path,
    updatedAt: minutesAgo(60 * 26),
  },
  {
    externalId: 's-grouped-themes',
    title: 'Group themes into families',
    status: 'ready',
    providerId: 'claude',
    isDriven: false,
    workspacePath: OPENMANAGER.path,
    updatedAt: minutesAgo(60 * 24 * 2),
    settledAt: minutesAgo(60 * 24),
  },
  {
    externalId: 's-send-flicker',
    title: 'Stop a sent message from flickering',
    status: 'ready',
    providerId: 'claude',
    isDriven: false,
    workspacePath: OPENMANAGER.path,
    updatedAt: minutesAgo(60 * 24 * 3),
    settledAt: minutesAgo(60 * 24 * 2),
  },
  {
    externalId: 's-t3code',
    title: 'Read t3code as a security reference',
    status: 'ready',
    providerId: 'claude',
    isDriven: false,
    workspacePath: T3CODE.path,
    workspaceUnavailable: true,
    updatedAt: minutesAgo(60 * 24 * 9),
    settledAt: minutesAgo(60 * 24 * 8),
  },
]

const msAgo = (minutes: number, now = Date.now()) => now - minutes * 60_000

/** Draft cards in the shared sidebar's shape: the project by id (its path), edits in ms. */
export const FIXTURE_DRAFTS: HomeDraft[] = [
  {
    draftId: 'd-upload-retry',
    sessionId: 's-draft-upload-retry',
    workspaceId: OPENMANAGER.path,
    providerId: 'claude',
    preview: 'Add a retry to the upload ticket when the socket drops mid-PUT',
    imageCount: 0,
    editedAt: msAgo(2),
  },
  {
    draftId: 'd-pricing',
    sessionId: 's-draft-pricing',
    workspaceId: SALESMAXAI.path,
    providerId: 'opencode',
    preview: 'Write the landing copy for the pricing page, three tiers',
    imageCount: 0,
    editedAt: msAgo(60),
  },
  {
    draftId: 'd-sidebar-remount',
    sessionId: 's-draft-sidebar-remount',
    workspaceId: OPENMANAGER.path,
    providerId: 'claude',
    preview: 'Why does the sidebar remount when the theme flips?',
    imageCount: 0,
    editedAt: msAgo(60 * 3),
    unsynced: 'offline',
  },
  {
    draftId: 'd-soul-avatar',
    sessionId: 's-draft-soul-avatar',
    workspaceId: CLEPRO.path,
    providerId: 'cursor',
    preview: 'Match this reference — the soul ID avatar grid',
    imageCount: 2,
    editedAt: msAgo(60 * 25),
  },
]
