import type { v2 } from '@openmanager/codex-app-server-protocol'

/** Protocol objects as `codex app-server` 0.170 sends them, for scripting a
 * fake server.
 *
 * Each builder starts from a shape copied out of a real recording (the
 * fixtures next to this file) and takes overrides, so a test names only what
 * it cares about and still sends the server's full object. They are typed
 * against the generated protocol: when the pinned CLI changes a field, these
 * stop compiling rather than quietly sending last version's shape.
 *
 * Times are fixed, not `Date.now()`, so two runs of a test write the same
 * bytes. */

/** 2026-11-20T12:00:00Z, the fake's notion of "now". */
export const FAKE_NOW_MS = 1_795_176_000_000
const FAKE_NOW_S = FAKE_NOW_MS / 1000

export const FAKE_CWD = '/workspace'
export const FAKE_MODEL = 'gpt-6-luna'

let counter = 0
/** A UUIDv7-looking id, unique within the test process. Codex's own thread
 * and turn ids are UUIDv7; tests that print them read better when the fakes
 * look alike. */
export function fakeId(prefix = ''): string {
  counter++
  const tail = counter.toString(16).padStart(12, '0')
  return `${prefix}01a1f7a1-0000-7000-8000-${tail}`
}

export function buildThread(overrides: Partial<v2.Thread> = {}): v2.Thread {
  const id = overrides.id ?? fakeId()
  const cwd = overrides.cwd ?? FAKE_CWD
  return {
    id,
    environments: [{ environmentId: 'local', cwd, runtimeWorkspaceRoots: [cwd] }],
    extra: null,
    sessionId: id,
    forkedFromId: null,
    attachedToThreadId: null,
    parentThreadId: null,
    preview: '',
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    projectId: null,
    historyMode: 'paginated',
    modelProvider: 'openai',
    model: FAKE_MODEL,
    reasoningEffort: null,
    createdAt: FAKE_NOW_S,
    updatedAt: FAKE_NOW_S,
    recencyAt: FAKE_NOW_S,
    status: { type: 'idle' },
    path: null,
    cwd,
    cliVersion: '0.170.0',
    originator: 'OpenManager',
    source: 'vscode',
    canAcceptDirectInput: true,
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    daybreakEnabled: null,
    turns: [],
    ...overrides,
  }
}

/** The answer to `thread/start` (and, with `turns` filled, `thread/resume`). */
export function buildThreadStartResponse(
  thread: v2.Thread,
  overrides: Partial<v2.ThreadStartResponse> = {},
): v2.ThreadStartResponse {
  return {
    thread,
    model: thread.model ?? FAKE_MODEL,
    modelProvider: thread.modelProvider,
    serviceTier: null,
    disabledPluginIds: [],
    cwd: thread.cwd,
    runtimeWorkspaceRoots: [thread.cwd],
    instructionSources: [],
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandbox: {
      type: 'workspaceWrite',
      writableRoots: [thread.cwd],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    },
    activePermissionProfile: null,
    reasoningEffort: null,
    multiAgentMode: 'explicitRequestOnly',
    ...overrides,
  }
}

export function buildTurn(overrides: Partial<v2.Turn> = {}): v2.Turn {
  const id = overrides.id ?? fakeId()
  return {
    id,
    rootTurnId: id,
    items: [],
    itemsView: 'notLoaded',
    status: 'inProgress',
    error: null,
    startedAt: FAKE_NOW_S,
    completedAt: null,
    durationMs: null,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Items. `ThreadItem` is a union keyed by `type`; each builder returns its own
// member so the caller keeps the narrow type.

type ItemOf<T extends v2.ThreadItem['type']> = Extract<v2.ThreadItem, { type: T }>

export function userMessageItem(text: string, overrides: Partial<ItemOf<'userMessage'>> = {}): ItemOf<'userMessage'> {
  return {
    type: 'userMessage',
    id: fakeId(),
    clientId: null,
    content: [{ type: 'text', text, text_elements: [] }],
    ...overrides,
  }
}

export function agentMessageItem(text: string, overrides: Partial<ItemOf<'agentMessage'>> = {}): ItemOf<'agentMessage'> {
  return {
    type: 'agentMessage',
    moderation: null,
    id: fakeId('msg_'),
    text,
    phase: 'final_answer',
    memoryCitation: null,
    delivery: null,
    questions: null,
    ...overrides,
  }
}

export function reasoningItem(summary: string[], overrides: Partial<ItemOf<'reasoning'>> = {}): ItemOf<'reasoning'> {
  return { type: 'reasoning', id: fakeId('rs_'), summary, content: [], ...overrides }
}

export function commandExecutionItem(
  command: string,
  overrides: Partial<ItemOf<'commandExecution'>> = {},
): ItemOf<'commandExecution'> {
  return {
    type: 'commandExecution',
    id: fakeId('exec-'),
    pluginId: null,
    scriptPath: null,
    command: `/bin/bash -lc '${command}'`,
    cwd: FAKE_CWD,
    processId: null,
    source: 'agent',
    status: 'inProgress',
    commandActions: [{ type: 'unknown', command }],
    aggregatedOutput: null,
    exitCode: null,
    durationMs: null,
    ...overrides,
  }
}

export function fileChangeItem(
  changes: v2.FileUpdateChange[],
  overrides: Partial<ItemOf<'fileChange'>> = {},
): ItemOf<'fileChange'> {
  return { type: 'fileChange', id: fakeId('exec-'), changes, status: 'inProgress', ...overrides }
}

/** The parent's record of a subagent starting or finishing. Codex 0.170 sends
 * no `thread/started` for a child thread: this item, and then the child's own
 * notifications carrying its `threadId`, are how the parent learns of it. */
export function subAgentActivityItem(
  agentThreadId: string,
  kind: v2.SubAgentActivityKind,
  overrides: Partial<ItemOf<'subAgentActivity'>> = {},
): ItemOf<'subAgentActivity'> {
  return {
    type: 'subAgentActivity',
    model: kind === 'started' ? FAKE_MODEL : null,
    reasoningEffort: kind === 'started' ? 'low' : null,
    id: fakeId('call_'),
    kind,
    agentThreadId,
    agentPath: '/root/helper',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Token usage

export function tokenUsageBreakdown(usage: Partial<v2.TokenUsageBreakdown> = {}): v2.TokenUsageBreakdown {
  const inputTokens = usage.inputTokens ?? 1000
  const outputTokens = usage.outputTokens ?? 10
  return {
    inputTokens,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens,
    reasoningOutputTokens: 0,
    totalTokens: inputTokens + outputTokens,
    ...usage,
  }
}

export function threadTokenUsage(
  last: Partial<v2.TokenUsageBreakdown> = {},
  total: Partial<v2.TokenUsageBreakdown> = last,
): v2.ThreadTokenUsage {
  return {
    total: tokenUsageBreakdown(total),
    last: tokenUsageBreakdown(last),
    modelContextWindow: 258_400,
  }
}

// ---------------------------------------------------------------------------
// Server request params. The context (`threadId`, `turnId`, `itemId`) comes
// first because it is what ties a request to the item it is about.

export type ItemContext = { threadId: string; turnId: string; itemId: string }

export function commandApprovalParams(
  context: ItemContext,
  overrides: Partial<v2.CommandExecutionRequestApprovalParams> = {},
): v2.CommandExecutionRequestApprovalParams {
  const command = overrides.command ?? "/bin/bash -lc 'mkdir made-by-codex'"
  return {
    kind: 'command',
    ...context,
    startedAtMs: FAKE_NOW_MS,
    environmentId: 'local',
    command,
    cwd: FAKE_CWD,
    commandActions: [{ type: 'unknown', command: 'mkdir made-by-codex' }],
    proposedExecpolicyAmendment: ['mkdir', 'made-by-codex'],
    availableDecisions: [
      'accept',
      { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['mkdir', 'made-by-codex'] } },
      'cancel',
    ],
    ...overrides,
  }
}

export function fileChangeApprovalParams(
  context: ItemContext,
  overrides: Partial<v2.FileChangeRequestApprovalParams> = {},
): v2.FileChangeRequestApprovalParams {
  return { ...context, startedAtMs: FAKE_NOW_MS, reason: null, grantRoot: null, ...overrides }
}

export function permissionsApprovalParams(
  context: ItemContext,
  overrides: Partial<v2.PermissionsRequestApprovalParams> = {},
): v2.PermissionsRequestApprovalParams {
  return {
    ...context,
    environmentId: 'local',
    startedAtMs: FAKE_NOW_MS,
    cwd: FAKE_CWD,
    reason: 'Write access to the workspace.',
    permissions: {
      network: null,
      fileSystem: {
        read: null,
        write: [FAKE_CWD],
        entries: [{ path: { type: 'path', path: FAKE_CWD }, access: 'write' }],
      },
    },
    ...overrides,
  }
}

export function userInputParams(
  context: ItemContext,
  overrides: Partial<v2.ToolRequestUserInputParams> = {},
): v2.ToolRequestUserInputParams {
  return {
    ...context,
    questions: [
      {
        id: 'q1',
        header: 'Pick one',
        question: 'Which file should I edit?',
        isOther: false,
        isSecret: false,
        options: [
          { label: 'a.txt', description: 'The first file' },
          { label: 'b.txt', description: 'The second file' },
        ],
      },
    ],
    isBlocking: true,
    autoResolutionMs: null,
    ...overrides,
  }
}

/** A form elicitation from an MCP server. The params type is an intersection
 * with a union, so overrides replace the whole form part. */
export function elicitationParams(
  context: { threadId: string; turnId: string | null },
  overrides: Partial<v2.McpServerElicitationRequestParams> = {},
): v2.McpServerElicitationRequestParams {
  return {
    ...context,
    serverName: 'fake-mcp',
    mode: 'form',
    _meta: null,
    message: 'Which environment?',
    requestedSchema: {
      type: 'object',
      properties: { environment: { type: 'string', title: 'Environment' } },
      required: ['environment'],
    },
    ...overrides,
  } as v2.McpServerElicitationRequestParams
}
