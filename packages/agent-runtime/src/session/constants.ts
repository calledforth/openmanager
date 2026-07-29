/** Timeouts on the live session path. `AcpBackend` has none: a spawn,
 * handshake or `session/new` that never answers hangs its caller forever.
 * Budgets are sized off measured cursor-agent latencies — spawn to first
 * stdout 2.2s, `initialize` 2.2s, `authenticate` 4.5s, `session/new` 3.5s
 * (~10.2s to a usable session) — with headroom for a cold machine. */
export type RuntimeTimeouts = {
  spawnMs: number
  initializeMs: number
  /** The one handshake step that can legitimately block on a *human* rather
   * than on a machine — see `DEFAULT_RUNTIME_TIMEOUTS`. */
  authenticateMs: number
  newSessionMs: number
  /** `session/load` replays the whole transcript as notifications before the
   * RPC answers, so it needs an order of magnitude more room. */
  loadSessionMs: number
  /** Every live-session RPC that is not a prompt: `set_config_option`,
   * `set_model`, `set_mode`, `session/cancel`, `session/list`. Measured worst
   * case is a Cursor `set_config_option` at 1.4–3.0s; `session/cancel` and
   * `session/list` are tens of milliseconds. These sit on the prompt's
   * critical path (`ensureSession` reconciles config before prompting), so a
   * wedged agent must not hang them forever. */
  controlRequestMs: number
  /** SIGTERM, then SIGKILL after this long. */
  terminateGraceMs: number
}

/** Budgets sized off the measured latencies quoted in `RuntimeTimeouts`.
 *
 * `authenticateMs` is the one that is not simply "measurement plus headroom".
 * Machine cost is 4.5s on Cursor and 60ms on OpenCode, so anything past ~10s
 * is not a latency allowance at all — it is an allowance for a CLI that wants
 * a browser round trip and is waiting on a person. Neither shipped provider
 * does that today (both authenticate against an already-completed CLI login),
 * but the two ways to be wrong are not symmetric: cutting a wedged agent off
 * late costs a hung-looking app for the remaining budget, while cutting a real
 * login off early destroys a sign-in the user has to start over. So this step
 * is deliberately the loosest of the handshake, and a dead CLI is still caught
 * in milliseconds regardless, because `bootstrap()` races every step against
 * the child's own exit. */
export const DEFAULT_RUNTIME_TIMEOUTS: RuntimeTimeouts = {
  spawnMs: 15_000,
  initializeMs: 20_000,
  authenticateMs: 60_000,
  newSessionMs: 30_000,
  loadSessionMs: 90_000,
  controlRequestMs: 30_000,
  terminateGraceMs: 2_000,
}

/** There is deliberately no prompt timeout: a turn legitimately runs for
 * minutes and only the user (or the process dying) may end it. That is why
 * `controlRequestMs` exists as its own budget — the non-prompt RPCs need a
 * ceiling and must not inherit the prompt's lack of one.
 *
 * A cursor-agent process costs ~141 MB RSS, so one process per session only
 * works with an idle reaper. Thresholds match the reference architecture. */
export const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000
export const SESSION_REAP_INTERVAL_MS = 5 * 60 * 1000

/** Soft ceiling on concurrently live session runtimes, enforced as an LRU
 * eviction in `SessionRuntimeRegistry.ensure`.
 *
 * The reaper alone bounds memory in *time*, not in *count*: a user working
 * across 20 threads inside one 30-minute window holds 20 processes at ~141 MB
 * each, ~2.8 GB, on a machine already running Electron and an editor. Eviction
 * turns an unbounded and unrecoverable failure (the OS killing the app, losing
 * whatever was in flight) into a bounded and recoverable one (a ~10.2s respawn
 * on next use, exactly what a reaped thread already pays).
 *
 * Soft, not hard: a runtime with a turn in flight is never evicted, so the
 * cap is exceeded rather than a turn destroyed (invariant 10's reasoning
 * applies identically here).
 *
 * Currently set high enough to be inert: at the measured ~230-300 MB per
 * Cursor session (node + its powershell and cmd.exe parents — the widely
 * quoted 141 MB counted only the node process), 100 runtimes is ~26 GB, so
 * the 30-minute reaper is the only backpressure that will realistically fire.
 * That matches the reference implementation, which caps provider runtimes not
 * at all. Deliberate and provisional — revisit against a real memory budget
 * once there is data on how many threads stay open in practice. A ~1 GB
 * ceiling is 4; a ~2 GB ceiling is 8. */
export const MAX_SESSION_RUNTIMES = 100

/** Whole-shutdown budget for terminating every runtime on app quit. One
 * runtime needs SIGTERM + `terminateGraceMs` + the SIGKILL to land, so this is
 * generous for the normal case and exists only so a CLI the OS refuses to kill
 * cannot hold the quit open forever. */
export const SHUTDOWN_BUDGET_MS = 8_000
