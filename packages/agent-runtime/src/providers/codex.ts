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
    // --- arrives with turns (CAL-253) -------------------------------------
    canLoadSession: false,
    canCancelPrompt: false,
    canSetModel: false,
    // --- arrives with the composer (CAL-260) ------------------------------
    // Access presets are the mode; reasoning effort and speed are options.
    canSetMode: false,
    canSetConfigOption: false,
    // --- arrives with steer (CAL-262) -------------------------------------
    canSteer: false,
    // --- arrives with tool items, approvals and questions -----------------
    supportsPermissionRequests: false,
    supportsQuestions: false,
    supportsSubtasks: false,
    supportsPlans: false,
    supportsThoughtStreaming: false,
    supportsUsage: false,
    // --- arrives with commands and skills (CAL-269) -----------------------
    supportsAvailableCommands: false,

    // --- structurally absent, not deferred --------------------------------
    // Sign-in is `codex login` on the machine (decision, CAL-245); there is
    // no in-app authenticate step.
    supportsAuthentication: false,
    // No ACP side-channel: everything Codex says is in its own protocol.
    supportsExtensions: false,
    // Openmanager owns the session list. Deleting archives the Codex thread
    // (CAL-271), which is not what `canDeleteSession` advertises.
    canDeleteSession: false,
    canListSessions: false,
  },
}
