import type { SessionConfigOption } from '@agentpack/contract'
import type { DesiredSessionConfig } from './lifecycle.js'

/** Where the current option list came from. Every one of these is a wire
 * response or notification — there is no local guessing. */
export type AppliedStateSource =
  | 'session/new'
  | 'session/load'
  | 'session/set_config_option'
  | 'config_option_update'
  /** No read-back exists: the value is what this runtime last successfully
   * wrote. Claude Code's `setModel`/`setPermissionMode` resolve without
   * echoing state, so "applied" there means "the write returned", which is a
   * weaker claim than the wire-confirmed sources above and is labelled as
   * such rather than being laundered into one of them. */
  | 'write_through'

/** Live mirror of one ACP session's config options.
 *
 * Scope is one process = one session: it is created empty with the runtime and
 * dies with the child, so a respawn can never serve state left behind by a
 * previous process. That matters for Cursor specifically, where model/config
 * state is process-global *and persisted on disk* — a fresh spawn was measured
 * reporting a model set by an already-exited process. Only what this session
 * reported over its own wire is trusted. */
export type AppliedSessionState = {
  /** Id of the option whose `category` is `'model'`. Cursor's parameterized
   * model picker routes the model through `session/set_config_option`, the
   * only variant that reads state back; `session/set_model` returns `{}` and
   * costs ~2.9s even when setting the identical value. Undefined when the
   * agent advertises no model option — then `session/set_model` is the only
   * path. */
  modelConfigId?: string
  modeConfigId?: string
  /** Every option the agent currently advertises, by id. Membership is the
   * legality test: the set is model-dependent (composer-2.5 exposes
   * mode/model/fast, claude-opus-5 exposes six) and sending an option the
   * current model does not have burns ~1.4s before failing with
   * "Unknown model config option". */
  options: ReadonlyMap<string, SessionConfigOption>
  /** ISO timestamp of the last refresh. */
  refreshedAt: string
  source: AppliedStateSource
}

/** What to do with one desired value. Only `'apply'` costs a round trip
 * (1.4-3.0s on Cursor); everything else is free. */
export type ConfigApplyDecision =
  | { decision: 'apply'; configId: string; option: SessionConfigOption; value: string | boolean }
  /** `currentValue` already matches — the entire point of the cache. */
  | { decision: 'satisfied'; configId: string; option: SessionConfigOption }
  /** The current model does not expose this option. Never send it. */
  | { decision: 'unsupported'; configId: string }
  /** The option exists but does not advertise this value. Never send it. */
  | { decision: 'invalid'; configId: string; option: SessionConfigOption; value: string | boolean }

/** Ordered reconciliation of a desired selection against the cache.
 *
 * `model` is applied FIRST and its response fed back through `refresh`,
 * because changing the model rewrites which options are legal. When
 * `staleAfterModelChange` is true, `mode`/`values` were computed against the
 * pre-change option list and must be re-planned after the model write lands. */
export type ConfigApplyPlan = {
  model?: ConfigApplyDecision
  mode?: ConfigApplyDecision
  values: readonly ConfigApplyDecision[]
  staleAfterModelChange: boolean
  /** A model/mode was desired but the agent advertises no option in that
   * category, so the legacy `session/set_model` / `session/set_mode` RPC is the
   * only path. Those return no state, so nothing can be cached: the caller
   * must track "last sent" itself to avoid re-sending. */
  legacySetModel: boolean
  legacySetMode: boolean
}

/** Cursor exposes some booleans as selects with `"true"`/`"false"` values, so
 * comparison goes through strings for everything except real booleans. */
export function configValueMatches(option: SessionConfigOption, value: string | boolean): boolean {
  if (option.type === 'boolean') return option.currentValue === value
  return option.currentValue.trim() === String(value).trim()
}

export function configValueAdvertised(
  option: SessionConfigOption,
  value: string | boolean,
): boolean {
  if (option.type === 'boolean') return typeof value === 'boolean'
  return option.options.some((candidate) => candidate.value === String(value).trim())
}

export class AppliedConfigCache {
  private options = new Map<string, SessionConfigOption>()
  private refreshedAt: string | undefined
  private source: AppliedStateSource | undefined

  /** Undefined until the session's first wire response has been folded in. */
  get state(): AppliedSessionState | undefined {
    if (!this.refreshedAt || !this.source) return undefined
    return {
      ...(this.modelConfigId ? { modelConfigId: this.modelConfigId } : {}),
      ...(this.modeConfigId ? { modeConfigId: this.modeConfigId } : {}),
      options: new Map(this.options),
      refreshedAt: this.refreshedAt,
      source: this.source,
    }
  }

  /** Replace the option list wholesale. Agents return the full array on every
   * `session/new`, `session/load` and `set_config_option`, so a merge would
   * keep options the current model has dropped. */
  refresh(
    options: readonly SessionConfigOption[],
    source: AppliedStateSource,
    at: string = new Date().toISOString(),
  ): void {
    this.options = new Map(options.map((option) => [option.id, option]))
    this.source = source
    this.refreshedAt = at
  }

  /** Drop everything. Used when a write failed in a way that leaves the
   * agent's state unknown. A failed write that reported an error is *not* one
   * of those: it never touched the cache, so the next attempt retries. */
  invalidate(): void {
    this.options = new Map()
    this.source = undefined
    this.refreshedAt = undefined
  }

  option(configId: string): SessionConfigOption | undefined {
    return this.options.get(configId)
  }

  /** Matches `AcpBackend.configOptionFor`: category first, then a literal
   * `id === 'model'` fallback for agents that omit categories. */
  get modelConfigId(): string | undefined {
    return this.categoryId('model')
  }

  get modeConfigId(): string | undefined {
    return this.categoryId('mode')
  }

  private categoryId(category: 'model' | 'mode'): string | undefined {
    for (const option of this.options.values()) {
      if (option.category === category) return option.id
    }
    return this.options.has(category) ? category : undefined
  }

  decide(configId: string, value: string | boolean): ConfigApplyDecision {
    const option = this.options.get(configId)
    if (!option) return { decision: 'unsupported', configId }
    if (configValueMatches(option, value)) return { decision: 'satisfied', configId, option }
    if (!configValueAdvertised(option, value))
      return { decision: 'invalid', configId, option, value }
    return { decision: 'apply', configId, option, value }
  }

  plan(desired: DesiredSessionConfig): ConfigApplyPlan {
    const modelConfigId = this.modelConfigId
    const modeConfigId = this.modeConfigId
    const model =
      desired.modelId !== undefined && modelConfigId !== undefined
        ? this.decide(modelConfigId, desired.modelId)
        : undefined
    const mode =
      desired.modeId !== undefined && modeConfigId !== undefined
        ? this.decide(modeConfigId, desired.modeId)
        : undefined
    const values = Object.entries(desired.values ?? {})
      .filter(([configId]) => configId !== modelConfigId && configId !== modeConfigId)
      .map(([configId, value]) => this.decide(configId, value))
    return {
      ...(model ? { model } : {}),
      ...(mode ? { mode } : {}),
      values,
      staleAfterModelChange: model?.decision === 'apply',
      legacySetModel: desired.modelId !== undefined && modelConfigId === undefined,
      legacySetMode: desired.modeId !== undefined && modeConfigId === undefined,
    }
  }
}
