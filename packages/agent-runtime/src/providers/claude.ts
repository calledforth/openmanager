import type { ClaudeProviderConfig } from './index.js'

/** Claude Code, driven through `@anthropic-ai/claude-agent-sdk` rather than ACP.
 *
 * `binary` names the *system* CLI and nothing else. The SDK ships its own
 * per-platform `claude` binary as an optional dependency and silently prefers
 * it whenever `pathToClaudeCodeExecutable` is omitted, which is exactly the
 * behaviour this config exists to prevent: a bundled binary pinned to whatever
 * SDK version happens to be installed would diverge from the CLI the user
 * signed in with, upgrades, and reads settings/hooks from. So the runtime and
 * the probe both resolve this `bin` themselves and always pass an explicit
 * path. If the CLI is not installed, that is an install failure we report as
 * one — never a silent fallback, and never a sign-in prompt.
 *
 * `CLAUDE_CODE_BIN` is the same escape hatch the ACP providers get from
 * `command.envOverride`: a non-PATH install (a version manager, a portable
 * checkout, a test double) stays usable without editing this file. */
export const claude: ClaudeProviderConfig = {
  kind: 'claude',
  id: 'claude',
  displayName: 'Claude Code',
  binary: { bin: 'claude', envOverride: 'CLAUDE_CODE_BIN' },
  capabilities: {
    // --- delivered by this commit ------------------------------------------
    // `query.setModel()` and `query.setPermissionMode()` are live control
    // requests on the streaming-input query the runtime already holds open.
    canSetModel: true,
    canSetMode: true,
    // `options.resume` plus a `getSessionInfo()` preflight, so a transcript the
    // CLI no longer has is classified rather than silently replaced.
    canLoadSession: true,
    // `query.interrupt()`, backed by the watchdog that replaces the runtime
    // when the interrupt produces neither a result nor an exit.
    canCancelPrompt: true,
    // The probe reads the full catalog off the `initialize` response, so
    // commands are known before any session exists — unlike ACP, where they
    // only ever arrive as a `session/update` on a live session.
    supportsAvailableCommands: true,

    // --- structurally absent, not deferred ---------------------------------
    // There is no per-session key/value config surface: model and permission
    // mode are their own control requests and everything else lives in
    // settings.json, which is the user's file and not ours to write.
    canSetConfigOption: false,
    // The SDK owns the credentials. There is no `authenticate` step to run and
    // no auth method to offer — a session either initializes or it does not,
    // and that is what the probe reports.
    supportsAuthentication: false,
    // Nothing analogous to ACP's `_meta`/`ext` side-channel: the SDK is an
    // in-process API, so there is no JSON-RPC surface for an agent to reach
    // back through with a provider-specific method.
    supportsExtensions: false,
    // Deliberate v1 omissions, NOT SDK gaps: `listSessions`, `getSessionInfo`
    // and `deleteSession` are all exported and all work. They stay off because
    // Convex is the source of truth for which sessions this app knows about,
    // and a second, divergent list read straight off `~/.claude/projects/`
    // would surface transcripts the app never created and offer to delete
    // files it does not own. Flipping either of these is a product decision
    // about session ownership, not an implementation task.
    canDeleteSession: false,
    canListSessions: false,

    // --- commit 3b turns these on -----------------------------------------
    // Each needs the full message translator: plan mode and the ExitPlanMode
    // tool (supportsPlans), `result.usage`/`getContextUsage` metering
    // (supportsUsage), `canUseTool` routing into the PermissionBroker
    // (supportsPermissionRequests), `thinking_delta` stream events
    // (supportsThoughtStreaming), Task tool correlation (supportsSubtasks),
    // and the AskUserQuestion tool (supportsQuestions).
    supportsPlans: false,
    supportsUsage: false,
    supportsPermissionRequests: false,
    supportsThoughtStreaming: false,
    supportsSubtasks: false,
    supportsQuestions: false,
  },
}
