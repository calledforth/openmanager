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
