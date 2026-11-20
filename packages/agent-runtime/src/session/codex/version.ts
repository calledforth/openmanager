import { CODEX_APP_SERVER_PROTOCOL_VERSION } from '@openmanager/codex-app-server-protocol'

/** The oldest codex-cli openmanager runs. The research covered the surface we
 * use end to end on 0.160; below it a session is refused rather than started
 * on a protocol nobody has checked. See docs/decisions/codex-app-server.md. */
export const CODEX_MIN_VERSION = '0.160.0'

/** The version the vendored protocol types were generated from. Between the
 * minimum and this one Codex runs, with a notice. */
export const CODEX_RECOMMENDED_VERSION = CODEX_APP_SERVER_PROTOCOL_VERSION

export type CodexVersionStatus = 'supported' | 'outdated' | 'unsupported' | 'unknown'

export type CodexVersionCheck = {
  /** As read from `userAgent`, e.g. `0.170.0`. Absent when it could not be read. */
  version?: string
  status: CodexVersionStatus
}

/** Read the codex-cli version out of `initialize.userAgent`.
 *
 * The agent is `<clientInfo.name>/<codex version> (<os>; <arch>) …`, e.g.
 * `OpenManager/0.170.0 (Ubuntu 24.4.0; x86_64) unknown (OpenManager; 0.1.0)`.
 * The name is ours, so the version is whatever follows the first `/`. Reading
 * it from the handshake saves spawning `codex --version` separately, and it
 * is the version of the process actually running, not of whatever is on PATH
 * by the time someone asks. */
export function parseCodexVersion(userAgent: string): string | undefined {
  return /^[^/\s]+\/(\d+\.\d+\.\d+[^\s]*)/.exec(userAgent.trim())?.[1]
}

export function checkCodexVersion(userAgent: string): CodexVersionCheck {
  const version = parseCodexVersion(userAgent)
  if (!version) return { status: 'unknown' }
  // A build from source reports 0.0.0; it is whatever the developer checked
  // out, so it is run (with a warning) rather than refused as ancient.
  if (compareVersions(version, '0.0.0') === 0) return { version, status: 'unknown' }
  if (compareVersions(version, CODEX_MIN_VERSION) < 0) return { version, status: 'unsupported' }
  if (compareVersions(version, CODEX_RECOMMENDED_VERSION) < 0) return { version, status: 'outdated' }
  return { version, status: 'supported' }
}

/** Numeric comparison of `major.minor.patch`. A pre-release suffix is
 * ignored: `0.171.0-alpha.2` counts as 0.171.0, which is the side to err on
 * for a developer running a build ahead of a release. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split(/[-+]/)[0]!.split('.').map((n) => Number.parseInt(n, 10) || 0)
  const [left, right] = [parts(a), parts(b)]
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}
