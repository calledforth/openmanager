import { subtaskFromClaudeTool } from '../session/claude/claude-tools.js'
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

    // Reasoning effort, fast mode and output style. None has a dedicated
    // control request — they are `Settings` keys written through
    // `query.applyFlagSettings()`, which is a session-scoped flag layer above
    // the user's own settings.json rather than an edit to it. The runtime
    // validates every write first, because that call does not: an unknown
    // output style is accepted and silently becomes current.
    canSetConfigOption: true,

    // --- structurally absent, not deferred ---------------------------------
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

    // --- delivered by the message translator and canUseTool routing --------
    // Two independent surfaces, both live: `TodoWrite` inputs become
    // `plan_update` snapshots, and the `ExitPlanMode` tool call becomes a
    // reviewable `plan_review_request` carrying `continuation: 'same_turn'`.
    supportsPlans: true,
    // `query.getContextUsage()` after every completed turn, which is the only
    // source that carries both halves of `SessionUsage`. `prompt_completed`
    // additionally carries per-turn `TokenUsage` accumulated from the stream.
    supportsUsage: true,
    // `canUseTool` parks the call on the app-wide `PermissionBroker` with
    // allow_once / allow_always / reject_once, and answers with the SDK's own
    // `updatedPermissions` suggestions for "always".
    supportsPermissionRequests: true,
    // Indicator only, and deliberately advertised anyway: Claude Code's
    // thinking blocks carry an always-empty string, so what streams is
    // start/stop framing plus a monotonic `estimated_tokens` reading. That is
    // what `ThoughtChunk.phase`/`tokens` exist for — the capability means
    // "reasoning is observable", not "reasoning arrives as prose".
    supportsThoughtStreaming: true,
    // `Task` tool calls are claimed by `subtasks.fromToolCall` below and become
    // `subtask_update`s instead of tool rows, with the subagent's own frames
    // feeding the row's activity.
    supportsSubtasks: true,
    // The `AskUserQuestion` tool, surfaced through the `InteractionBroker` and
    // answered back into the tool's `{questions, answers}` input shape.
    supportsQuestions: true,
  },
  // Attaching the adapter is not enough on its own — `ClaudeMessageTranslator`
  // has to invoke it and track the ids it claims, the way
  // `AcpSessionRuntimeImpl.subtaskFromTool` does for the ACP transport.
  subtasks: { fromToolCall: subtaskFromClaudeTool },
}
