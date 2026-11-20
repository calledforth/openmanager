import type { ModeListing, ModeOption } from '@agentpack/contract'
import type { v2 } from '@openmanager/codex-app-server-protocol'

/** The Access presets (docs/decisions/codex-app-server.md, "Access presets").
 * Codex's mode control in openmanager; there is no Codex plan mode. */
export type CodexAccessPreset = 'supervised' | 'auto-accept-edits' | 'auto' | 'full-access'

export type CodexAccess = {
  approvalPolicy: v2.AskForApproval
  approvalsReviewer: v2.ApprovalsReviewer
  /** `thread/start` / `thread/resume` spelling. */
  sandbox: v2.SandboxMode
  /** `turn/start` / `thread/settings/update` spelling. */
  sandboxPolicy: v2.SandboxPolicy
}

const WORKSPACE_WRITE: v2.SandboxPolicy = {
  type: 'workspaceWrite',
  // The thread's cwd is writable already; nothing beyond it is granted.
  writableRoots: [],
  networkAccess: false,
  excludeTmpdirEnvVar: false,
  excludeSlashTmp: false,
}

export function codexAccess(preset: CodexAccessPreset): CodexAccess {
  switch (preset) {
    case 'supervised':
      return {
        approvalPolicy: 'untrusted',
        approvalsReviewer: 'user',
        sandbox: 'read-only',
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
      }
    case 'auto-accept-edits':
      return {
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        sandbox: 'workspace-write',
        sandboxPolicy: WORKSPACE_WRITE,
      }
    case 'auto':
      return {
        approvalPolicy: 'on-request',
        approvalsReviewer: 'auto_review',
        sandbox: 'workspace-write',
        sandboxPolicy: WORKSPACE_WRITE,
      }
    case 'full-access':
      return {
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        sandbox: 'danger-full-access',
        sandboxPolicy: { type: 'dangerFullAccess' },
      }
  }
}

/** Auto-accept edits everywhere the sandbox works. Native Windows gets Full
 * access until its sandbox does (CAL-273): the Windows sandbox runs commands
 * as a separate user, which breaks Git and `%TEMP%` in ways that look like
 * Codex bugs. */
export function defaultCodexAccessPreset(
  platform: NodeJS.Platform = process.platform,
): CodexAccessPreset {
  return platform === 'win32' ? 'full-access' : 'auto-accept-edits'
}

/** The presets in the order the composer lists them, least access first. */
export const CODEX_ACCESS_PRESETS: readonly CodexAccessPreset[] = [
  'supervised',
  'auto-accept-edits',
  'auto',
  'full-access',
]

/** The presets as the composer's Access control shows them. */
export const CODEX_ACCESS_MODES: readonly ModeOption[] = [
  {
    id: 'supervised',
    displayName: 'Supervised',
    description: 'Read-only sandbox. Asks before running anything it does not trust.',
  },
  {
    id: 'auto-accept-edits',
    displayName: 'Auto-accept edits',
    description: 'Edits inside the workspace go through. Anything that leaves the sandbox asks.',
  },
  {
    id: 'auto',
    displayName: 'Auto',
    description:
      'Sandboxed like Auto-accept edits, but a reviewer agent answers what would ask you.',
  },
  {
    id: 'full-access',
    displayName: 'Full access',
    description: 'No sandbox and no approvals. Use with care.',
  },
]

export function isCodexAccessPreset(value: string | undefined): value is CodexAccessPreset {
  return (CODEX_ACCESS_PRESETS as readonly string[]).includes(value ?? '')
}

/** The Access control's listing, with `current` in force. */
export function codexModeListing(current: CodexAccessPreset | undefined): ModeListing {
  return {
    availableModes: [...CODEX_ACCESS_MODES],
    ...(current ? { currentModeId: current } : {}),
  }
}

/** `guardian_subagent` is the older name of `auto_review`. */
export function canonicalReviewer(reviewer: v2.ApprovalsReviewer): v2.ApprovalsReviewer {
  return reviewer === 'guardian_subagent' ? 'auto_review' : reviewer
}

/** The preset a thread's settings amount to, read back from Codex
 * (`thread/settings/updated`, or a thread's start or resume). Undefined when
 * they match none: settings from the user's own config, a granular approval
 * policy, or a sandbox no preset uses. */
export function codexAccessPresetOf(settings: {
  approvalPolicy: v2.AskForApproval
  approvalsReviewer: v2.ApprovalsReviewer
  sandboxPolicy: v2.SandboxPolicy
}): CodexAccessPreset | undefined {
  return CODEX_ACCESS_PRESETS.find((preset) => {
    const access = codexAccess(preset)
    return (
      typeof settings.approvalPolicy === 'string' &&
      settings.approvalPolicy === access.approvalPolicy &&
      canonicalReviewer(settings.approvalsReviewer) === canonicalReviewer(access.approvalsReviewer) &&
      settings.sandboxPolicy.type === access.sandboxPolicy.type
    )
  })
}
