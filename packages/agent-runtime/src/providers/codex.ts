import type { CodexProviderConfig } from './index.js'

/** OpenAI Codex, driven through `codex app-server` rather than ACP.
 *
 * How it is run is recorded in docs/decisions/codex-app-server.md: one
 * app-server per session, the user's own `~/.codex`, sign-in through
 * `codex login`. The binary is resolved by `resolveCodexExecutable`
 * (`CODEX_BIN`, then `PATH`, then the desktop app's standalone CLI); there is
 * no `bin` here because the fallbacks after the env override are a search,
 * not one name.
 *
 * Every capability starts off and is switched on by the change that delivers
 * it, so the app never offers a control the runtime cannot honour yet. */
export const codex: CodexProviderConfig = {
  kind: 'codex',
  id: 'codex',
  displayName: 'Codex',
  binary: { envOverride: 'CODEX_BIN' },
  capabilities: {
    // --- delivered with turns (CAL-253) -----------------------------------
    // `thread/resume` by thread id, falling back to a fresh thread only when
    // Codex says it has none.
    canLoadSession: true,
    // `turn/interrupt`, a bounded wait, then the turn is closed regardless.
    canCancelPrompt: true,
    // Every `turn/start` names the model, so a change applies next turn.
    canSetModel: true,
    // Reasoning summaries, one short headline per part (`summary: "detailed"`).
    supportsThoughtStreaming: true,
    // Per-turn token counts and the context window, from
    // `thread/tokenUsage/updated`.
    supportsUsage: true,
    // --- arrives with the composer (CAL-260) ------------------------------
    // Access presets are the mode; reasoning effort and speed are options.
    canSetMode: false,
    canSetConfigOption: false,
    // --- delivered with steer (CAL-262) -----------------------------------
    // `turn/steer` into the turn in flight, shown where Codex echoes it. A
    // refused steer is queued for the next turn; one already sent cannot be
    // taken back.
    canSteer: true,
    // --- delivered with background terminals (CAL-272) --------------------
    // A command left running when its turn ends is listed by the
    // experimental `thread/backgroundTerminals/list` and stopped by
    // `thread/backgroundTerminals/terminate`. A Codex that refuses the list
    // reports no background tasks.
    supportsBackgroundTasks: true,
    // A terminal that ends starts no turn: a turn completing beside a dev
    // server is done.
    backgroundTasksWakeAgent: false,
    // --- arrives with tool items, approvals and questions -----------------
    supportsPermissionRequests: false,
    supportsQuestions: false,
    supportsSubtasks: false,
    supportsPlans: false,
    // --- arrives with commands and skills (CAL-269) -----------------------
    supportsAvailableCommands: false,

    // --- structurally absent, not deferred --------------------------------
    // Sign-in is `codex login` on the machine (decision, CAL-245); there is
    // no in-app authenticate step.
    supportsAuthentication: false,
    // No ACP side-channel: everything Codex says is in its own protocol.
    supportsExtensions: false,
    // Openmanager owns the session list, and deleting a session is always
    // openmanager's own. `canDeleteSession` advertises deleting from the
    // provider's list, which Codex never does: a deleted session's thread is
    // archived instead, through `AgentRuntime.retireSession`.
    canDeleteSession: false,
    canListSessions: false,
  },
}
