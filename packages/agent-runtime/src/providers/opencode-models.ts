import { execFile as nodeExecFile } from 'node:child_process'
import type { HostDeps } from '../host.js'
import type { ModelImageInputLookup } from './index.js'

/** `opencode models <provider> --verbose --pure` prints one JSON object per
 * model. This is the only place OpenMANAGER learns whether an OpenCode model
 * can read images: ACP's catalog has no such flag, and the desktop used to
 * run exactly this command from Electron's main process. The parser and the
 * cache moved here so the environment server and the desktop share one copy.
 *
 * Model ids are `<upstream provider>/<model>`, e.g. `anthropic/claude-sonnet-4`.
 * The CLI lists one upstream provider per call and prints its whole catalog,
 * so one spawn answers every model under that prefix — the cache is filled
 * for all of them, not just the ids asked about. An id without a slash is
 * not an OpenCode model id and is reported unknown without spawning. */

export type ExecFile = (
  command: string,
  args: readonly string[],
  options: { windowsHide: boolean; maxBuffer: number },
) => Promise<{ stdout: string }>

export type OpencodeModelLookupOptions = {
  /** The `opencode` binary, already resolved through the env override. */
  command: string
  log?: HostDeps['log']
  /** Injected by tests; defaults to `node:child_process`. */
  execFile?: ExecFile
  /** How long a failed listing for one upstream provider is held before the
   * CLI is asked again. Bounds the spawn rate when the CLI is broken: every
   * new model id under that prefix would otherwise cost a fresh process. */
  failureHoldMs?: number
  now?: () => number
}

const FAILURE_HOLD_MS = 5 * 60 * 1000
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024

const defaultExecFile: ExecFile = (command, args, options) =>
  new Promise((resolve, reject) => {
    nodeExecFile(command, args, options, (error, stdout) => {
      if (error) reject(error)
      else resolve({ stdout: String(stdout) })
    })
  })

/** Every top-level JSON object in `output`, in order. The CLI's `--pure`
 * output is a stream of objects rather than one array, and a banner or a
 * warning line between them must not lose the ones after it. A malformed
 * object is skipped on its own. */
export function jsonObjects(output: string): Record<string, unknown>[] {
  const objects: Record<string, unknown>[] = []
  let start = -1
  let depth = 0
  let quoted = false
  let escaped = false
  for (let index = 0; index < output.length; index += 1) {
    const char = output[index]
    if (quoted) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quoted = false
      continue
    }
    if (char === '"') quoted = true
    else if (char === '{') {
      if (depth === 0) start = index
      depth += 1
    } else if (char === '}' && depth > 0) {
      depth -= 1
      if (depth === 0 && start >= 0) {
        try {
          const parsed: unknown = JSON.parse(output.slice(start, index + 1))
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            objects.push(parsed as Record<string, unknown>)
          }
        } catch {
          // Leave this one unknown rather than fail the whole listing.
        }
        start = -1
      }
    }
  }
  return objects
}

/** What one printed model says about image input: a real boolean, or `null`
 * when the field is missing or not a boolean. */
function imageInputOf(model: Record<string, unknown>): boolean | null {
  const capabilities = model.capabilities
  if (!capabilities || typeof capabilities !== 'object') return null
  const input = (capabilities as Record<string, unknown>).input
  if (!input || typeof input !== 'object') return null
  const image = (input as Record<string, unknown>).image
  return typeof image === 'boolean' ? image : null
}

export function createOpencodeModelImageInputLookup(
  options: OpencodeModelLookupOptions,
): ModelImageInputLookup {
  const execFile = options.execFile ?? defaultExecFile
  const now = options.now ?? Date.now
  const failureHoldMs = options.failureHoldMs ?? FAILURE_HOLD_MS
  /** Every model the CLI has ever printed, plus `null` for ids it was asked
   * about and did not print. Process-lifetime: a model's vision support does
   * not change under a running server. */
  const known = new Map<string, boolean | null>()
  /** One listing in flight per upstream provider; concurrent asks share it. */
  const inFlight = new Map<string, Promise<void>>()
  const failedUntil = new Map<string, number>()

  const list = async (prefix: string): Promise<void> => {
    let stdout: string
    try {
      ;({ stdout } = await execFile(options.command, ['models', prefix, '--verbose', '--pure'], {
        windowsHide: true,
        maxBuffer: MAX_OUTPUT_BYTES,
      }))
    } catch (error) {
      failedUntil.set(prefix, now() + failureHoldMs)
      options.log?.({
        scope: 'acp',
        level: 'warn',
        message: 'Could not list OpenCode models for image support',
        data: { provider: prefix, error: error instanceof Error ? error.message : String(error) },
      })
      return
    }
    failedUntil.delete(prefix)
    for (const model of jsonObjects(stdout)) {
      const providerId = model.providerID
      const id = model.id
      if (typeof providerId !== 'string' || typeof id !== 'string') continue
      known.set(`${providerId}/${id}`, imageInputOf(model))
    }
  }

  const listOnce = (prefix: string): Promise<void> => {
    const pending = inFlight.get(prefix)
    if (pending) return pending
    const run = list(prefix).finally(() => {
      if (inFlight.get(prefix) === run) inFlight.delete(prefix)
    })
    inFlight.set(prefix, run)
    return run
  }

  return async (modelIds) => {
    const answers = new Map<string, boolean | null>()
    const prefixes = new Set<string>()
    for (const modelId of modelIds) {
      const slash = modelId.indexOf('/')
      if (slash <= 0) {
        answers.set(modelId, null)
        continue
      }
      if (known.has(modelId)) {
        answers.set(modelId, known.get(modelId) ?? null)
        continue
      }
      const prefix = modelId.slice(0, slash)
      const held = failedUntil.get(prefix)
      // Inside the hold the id is left out: "could not ask right now", which
      // the caller may retry, rather than `null`, which it would keep.
      if (held !== undefined && held > now()) continue
      prefixes.add(prefix)
    }
    await Promise.all([...prefixes].map(listOnce))
    for (const modelId of modelIds) {
      if (answers.has(modelId)) continue
      const prefix = modelId.slice(0, modelId.indexOf('/'))
      if (failedUntil.has(prefix)) continue
      // Listed under this prefix but not printed: the CLI does not know it.
      // Remembered so the next ask for the same id costs no process.
      if (!known.has(modelId)) known.set(modelId, null)
      answers.set(modelId, known.get(modelId) ?? null)
    }
    return answers
  }
}
