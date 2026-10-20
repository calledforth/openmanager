import { it } from 'vitest'
import { Rig, type RigOptions } from './harness.ts'
import { recordEvidence } from './evidence.ts'

/** Long scenarios and the larger seed sets run only in the nightly mode. */
export const NIGHTLY = process.env.CONVERGENCE_NIGHTLY === '1'
/** Run each scenario this many times in a row, each on a fresh rig; any failure fails it. */
export const REPEAT = Math.max(1, Number(process.env.CONVERGENCE_REPEAT ?? '1') || 1)

export interface ScenarioOptions extends RigOptions {
  /** Only in `--mode nightly`. */
  nightly?: boolean
  /** Per run, in milliseconds. */
  timeoutMs?: number
}

type Body = (rig: Rig) => Promise<void>

async function withRig(options: ScenarioOptions, body: Body): Promise<void> {
  const rig = await Rig.create(options)
  try {
    await body(rig)
    if (rig.server.fatals.length > 0) {
      throw new Error(`The server child reported failures:\n${rig.server.fatals.join('\n')}`)
    }
  } catch (error) {
    const diagnostics = rig.server.diagnostics()
    if (diagnostics && error instanceof Error) {
      error.message += `\n--- server child output (tail) ---\n${diagnostics}`
    }
    throw error
  } finally {
    await rig.dispose()
  }
}

/**
 * A scenario: `REPEAT` runs, each on its own server, data directory and
 * proxy. Run times are recorded with the evidence.
 */
export function scenario(name: string, options: ScenarioOptions, body: Body): void {
  const run = options.nightly && !NIGHTLY ? it.skip : it
  run(name, { timeout: (options.timeoutMs ?? 120_000) * REPEAT + 30_000 }, async () => {
    const durations: number[] = []
    for (let attempt = 0; attempt < REPEAT; attempt++) {
      const started = performance.now()
      await withRig(options, body)
      durations.push(Math.round(performance.now() - started))
    }
    recordEvidence({
      scenario: name,
      bucket: 'timing',
      cause: 'run times',
      observed: { runs: REPEAT, durationsMs: durations },
    })
  })
}

/**
 * A future test whose seam does not exist on this build (a phase adds it).
 * There is no body: it is written by the phase that adds the seam, from the
 * construction recorded here.
 */
export function futureTest(name: string, phase: string, construction: string): void {
  void construction
  it.todo(`${name} (future test, needs ${phase})`)
}

/**
 * A future test whose body is written against today's harness and protocol,
 * but whose assertions describe a phase not yet built, so it is skipped.
 * The phase that lands removes `phase` from the skip, and fixes anything the
 * new protocol changes (message names, reference-client adapters).
 */
export function afterPhase(
  name: string,
  phase: string,
  options: ScenarioOptions,
  body: Body,
): void {
  it.skip(`${name} (after ${phase})`, { timeout: options.timeoutMs ?? 120_000 }, async () => {
    await withRig(options, body)
  })
}
