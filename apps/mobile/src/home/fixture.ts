/**
 * A realistic environment for showing the shell without a server: the titles
 * and projects are the owner's own (lifted from the mockups), the shapes are
 * the shared sidebar entries. The home reads it only on a phone with nothing
 * paired, and only when the build sets `EXPO_PUBLIC_FIXTURE=1`
 * (`source.ts`); nothing here reaches a server.
 *
 * Two environments by default, so the home shows where each row runs; with
 * `EXPO_PUBLIC_FIXTURE_ONE_ENV=1` everything runs on the first, which is a
 * phone paired with one computer.
 */
import type { WorkspaceEntry } from '@openmanager/app-core/providers/sidebar-provider'

import type { HomeDraft, HomeEnvironmentRef, HomeSession } from './rows'

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

export const FIXTURE_SECOND_ENVIRONMENT: FixtureEnvironment = {
  environmentId: 'env-wsl',
  label: 'WSL · ubuntu',
  route: { kind: 'tunnel', address: 'wsl.cletus.xyz', latencyMs: 84 },
}

export const FIXTURE_ENVIRONMENTS: FixtureEnvironment[] = [
  FIXTURE_ENVIRONMENT,
  FIXTURE_SECOND_ENVIRONMENT,
]

/** The build asked for one environment; Expo inlines `EXPO_PUBLIC_*` at bundle time. */
const ONE_ENVIRONMENT = process.env.EXPO_PUBLIC_FIXTURE_ONE_ENV === '1'

const ref = (environment: FixtureEnvironment): HomeEnvironmentRef => ({
  environmentId: environment.environmentId,
  label: environment.label,
})
const DESKTOP = ref(FIXTURE_ENVIRONMENT)
const WSL = ONE_ENVIRONMENT ? DESKTOP : ref(FIXTURE_SECOND_ENVIRONMENT)

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
  {
    path: '/home/cletus/queue',
    name: 'queue',
    availability: 'available',
    lastActivityAt: minutesAgo(18),
    git: { branch: 'main', worktree: false },
  },
]

const [OPENMANAGER, SALESMAXAI, CLEPRO, T3CODE, QUEUE] = FIXTURE_WORKSPACES as [
  WorkspaceEntry,
  WorkspaceEntry,
  WorkspaceEntry,
  WorkspaceEntry,
  WorkspaceEntry,
]

/** A settled session for the long tail, `days` ago. */
const settled = (externalId: string, title: string, days: number): HomeSession => ({
  externalId,
  title,
  status: 'ready',
  providerId: 'claude',
  isDriven: false,
  workspacePath: OPENMANAGER.path,
  updatedAt: minutesAgo(60 * 24 * days + 60),
  settledAt: minutesAgo(60 * 24 * days),
  environment: DESKTOP,
})

export const FIXTURE_SESSIONS: HomeSession[] = [
  {
    externalId: 's-tool-payloads',
    title: 'Codex Integration: Tool Call Payloads',
    status: 'running',
    providerId: 'claude',
    isDriven: false,
    workspacePath: OPENMANAGER.path,
    updatedAt: minutesAgo(0),
    environment: DESKTOP,
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
    environment: DESKTOP,
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
    environment: DESKTOP,
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
    environment: DESKTOP,
  },
  {
    externalId: 's-gap-analysis',
    title: 'Mobile Client Gap Analysis and Plan',
    status: 'running',
    inBackground: true,
    backgroundTaskCount: 2,
    backgroundTaskNames: 'vitest --watch\ndev server',
    providerId: 'claude',
    isDriven: false,
    workspacePath: OPENMANAGER.path,
    updatedAt: minutesAgo(6),
    pinnedAt: minutesAgo(60 * 5),
    environment: DESKTOP,
  },
  {
    externalId: 's-mcp-server',
    title: 'MCP server for the ticket queue',
    status: 'running',
    providerId: 'opencode',
    isDriven: false,
    workspacePath: QUEUE.path,
    updatedAt: minutesAgo(18),
    environment: WSL,
  },
  {
    externalId: 's-harness-drift',
    title: 'Nightly convergence harness: summarise drift',
    status: 'waiting',
    waitingOn: 'question',
    providerId: 'claude',
    isDriven: false,
    workspacePath: QUEUE.path,
    updatedAt: minutesAgo(9),
    environment: WSL,
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
    environment: DESKTOP,
  },
  {
    externalId: 's-sync-f2',
    title: 'Sync foundations: convergence harness',
    status: 'error',
    providerId: 'claude',
    isDriven: false,
    workspacePath: QUEUE.path,
    updatedAt: minutesAgo(60 * 3),
    environment: WSL,
  },
  {
    externalId: 's-portfolio',
    title: 'Freelancer Portfolio Site',
    status: 'ready',
    providerId: 'cursor',
    isDriven: false,
    workspacePath: CLEPRO.path,
    updatedAt: minutesAgo(60 * 26),
    hasUnsentDraft: true,
    environment: DESKTOP,
  },
  {
    externalId: 's-zen-helium',
    title: 'Agent Browser Control With Zen Helium',
    status: 'ready',
    providerId: 'claude',
    isDriven: false,
    workspacePath: OPENMANAGER.path,
    updatedAt: minutesAgo(60 * 24 * 2),
    environment: DESKTOP,
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
    environment: DESKTOP,
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
    environment: DESKTOP,
  },
  {
    externalId: 's-whop-fee',
    title: 'Waiving Whop $500 Setup Fee for Users',
    status: 'ready',
    providerId: 'opencode',
    isDriven: false,
    workspacePath: SALESMAXAI.path,
    updatedAt: minutesAgo(60 * 24 * 4),
    settledAt: minutesAgo(60 * 24 * 4),
    environment: DESKTOP,
  },
  {
    externalId: 's-queue-schema',
    title: 'Queue schema and migrations',
    status: 'ready',
    providerId: 'claude',
    isDriven: false,
    workspacePath: QUEUE.path,
    updatedAt: minutesAgo(60 * 24 * 5),
    settledAt: minutesAgo(60 * 24 * 5),
    environment: WSL,
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
    environment: DESKTOP,
  },
  settled('s-session-cards', 'Session cards: question and background states', 2),
  settled('s-settings-routes', 'Settings redesign: environment cards and routes', 3),
  settled('s-scheduled', 'Scheduled prompts: nightly harness run', 5),
  settled('s-tunnel', 'Cloudflare tunnel: named tunnel only', 6),
  settled('s-portfolio-plan', 'Freelancer Portfolio Website Planning', 12),
  settled('s-render-isolation', 'Sidebar render isolation audit', 14),
  settled('s-upload-tickets', 'Upload tickets with credential PUT', 21),
  settled('s-titles', 'Generated session titles, protocol v9', 30),
  settled('s-landing-draft', 'Web landing draft via onLanding', 33),
  settled('s-folder-browser', 'Folder browser and settings store', 40),
  settled('s-pairing-links', 'Pairing links and device list', 46),
  settled('s-artifact-preview', 'Artifact preview with object-URL cache', 52),
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
    environment: DESKTOP,
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
    environment: DESKTOP,
  },
  {
    draftId: 'd-soul-avatar',
    sessionId: 's-draft-soul-avatar',
    workspaceId: CLEPRO.path,
    providerId: 'cursor',
    preview: 'Match this reference — the soul ID avatar grid',
    imageCount: 2,
    editedAt: msAgo(60 * 25),
    environment: WSL,
  },
]
