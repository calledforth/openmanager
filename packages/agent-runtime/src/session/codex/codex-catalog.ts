import type {
  ModelListing,
  ModelOption,
  ModelUpgrade,
  ProviderPolicy,
  ProviderPolicyBlock,
  SessionConfigOption,
} from '@agentpack/contract'
import type { v2, WebSearchMode } from '@openmanager/codex-app-server-protocol'
import { codexAccess, type CodexAccessPreset } from './codex-access.js'
import type { ClientMethod, ClientParams, ClientResult } from './CodexAppServerClient.js'

/** Anything that can put a request to an app-server: a client, or the
 * service process in front of one. */
export type CodexRequester = {
  request<M extends ClientMethod>(
    method: M,
    params: ClientParams<M>,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<ClientResult<M>>
}

/** Most pages any list is followed for. The catalog is about ten models and
 * the lists below are shorter; the bound only stops a server that keeps
 * returning a cursor from holding the probe forever. */
const MAX_PAGES = 10

async function readPages<T>(
  read: (cursor: string | null) => Promise<{ data: T[]; nextCursor: string | null }>,
): Promise<T[]> {
  const items: T[] = []
  let cursor: string | null = null
  for (let page = 0; page < MAX_PAGES; page++) {
    const response = await read(cursor)
    items.push(...response.data)
    cursor = response.nextCursor
    if (!cursor) break
  }
  return items
}

/** Every model the account can pick, across `model/list`'s pages. Hidden
 * models are not asked for (`includeHidden` is left off). */
export function readCodexModels(client: CodexRequester): Promise<v2.Model[]> {
  return readPages((cursor) => client.request('model/list', cursor ? { cursor } : {}))
}

/** `permissionProfile/list` for a directory (its project config layers
 * count), every page. */
export function readCodexPermissionProfiles(
  client: CodexRequester,
  cwd?: string,
): Promise<v2.PermissionProfileSummary[]> {
  return readPages((cursor) =>
    client.request('permissionProfile/list', {
      ...(cursor ? { cursor } : {}),
      ...(cwd ? { cwd } : {}),
    }),
  )
}

/** The feature flags openmanager's catalog depends on, by their
 * `config.toml` key:
 *
 * - `fast_mode`: the Fast service tier (`priority`). Off, Codex refuses it.
 * - `guardian_approval`: the `auto_review` reviewer behind the Auto access
 *   preset.
 *
 * Every other flag is Codex's own business and is not kept. */
export const CODEX_RELIED_ON_FEATURES = ['fast_mode', 'guardian_approval'] as const
export type CodexFeatureName = (typeof CODEX_RELIED_ON_FEATURES)[number]
/** Whether each relied-on flag is on in the loaded config. A flag Codex did
 * not list is absent, which reads as "as Codex defaults". */
export type CodexFeatures = Partial<Record<CodexFeatureName, boolean>>

export async function readCodexFeatures(client: CodexRequester): Promise<CodexFeatures> {
  const all = await readPages((cursor) =>
    client.request('experimentalFeature/list', cursor ? { cursor } : {}),
  )
  const features: CodexFeatures = {}
  for (const feature of all)
    if ((CODEX_RELIED_ON_FEATURES as readonly string[]).includes(feature.name))
      features[feature.name as CodexFeatureName] = feature.enabled
  return features
}

/** Config ids the composer and the runtime agree on for Codex. Strings, as
 * every config id is: they cross the wire as opaque keys. */
export const CODEX_CONFIG = {
  effort: 'effort',
  serviceTier: 'service_tier',
  webSearch: 'web_search',
} as const

/** The service tier Codex calls Fast. */
export const CODEX_FAST_SERVICE_TIER = 'priority'

/** What else the catalog is read against: the managed policy and the flags. */
export type CodexCatalogContext = {
  requirements?: v2.ConfigRequirements | null
  features?: CodexFeatures
}

/** Codex's catalog in the shape every composer reads.
 *
 * Hidden models are left out: `model/list` already omits them unless asked,
 * and one that slipped through is one Codex itself would not offer. What
 * each model accepts — its reasoning efforts, its service tiers, whether it
 * reads images — comes from the catalog, never from a list kept here, so a
 * CLI upgrade that adds a model, an effort or a tier needs no change in
 * openmanager. A managed policy's new-thread defaults choose the default
 * model, effort and tier where it names ones the catalog offers. */
export function codexModelListing(
  models: readonly v2.Model[],
  context: CodexCatalogContext = {},
): ModelListing {
  const visible = models.filter((model) => !model.hidden)
  const defaults = context.requirements?.models?.newThread
  const current =
    visible.find((model) => defaults?.model && model.id === defaults.model) ??
    visible.find((model) => model.isDefault) ??
    visible[0]
  return {
    availableModels: visible.map((model) => codexModelOption(model, context)),
    ...(current ? { currentModelId: current.id } : {}),
  }
}

/** Read tolerantly: the catalog's shape moves with the CLI, and a field an
 * older or newer Codex leaves out reads as "none" rather than failing the
 * whole listing. */
export function codexModelOption(model: v2.Model, context: CodexCatalogContext = {}): ModelOption {
  const efforts = (model.supportedReasoningEfforts ?? []).map((option) => option.reasoningEffort)
  const tiers = codexServiceTiers(model, context)
  const upgrade = codexModelUpgrade(model)
  return {
    id: model.id,
    displayName: model.displayName || model.id,
    ...(model.description ? { description: model.description } : {}),
    ...(efforts.length > 0 ? { effortLevels: efforts } : {}),
    ...(tiers.some((tier) => tier.id === CODEX_FAST_SERVICE_TIER) ? { supportsFastMode: true } : {}),
    // Absent means "could not say" to the composer, which lets an image
    // through; Codex always says, so this is a real answer either way.
    supportsImageInput: (model.inputModalities ?? []).includes('image'),
    configOptions: codexModelConfigOptions(model, tiers, context),
    ...(upgrade ? { upgrade } : {}),
  }
}

/** The tiers a model offers that may be used here. Fast needs its feature
 * flag on, and a managed policy may pin it off. */
function codexServiceTiers(model: v2.Model, context: CodexCatalogContext): v2.ModelServiceTier[] {
  const fastOff =
    context.features?.fast_mode === false ||
    context.requirements?.featureRequirements?.fast_mode === false
  return (model.serviceTiers ?? []).filter((tier) => !(fastOff && tier.id === CODEX_FAST_SERVICE_TIER))
}

/** A model's settings as a draft shows them: reasoning effort with Codex's
 * own description of each level, and speed (the service tier), each with the
 * catalog's default as its value. The ids are Codex's, untranslated, so an
 * effort or tier added upstream shows up as itself. */
function codexModelConfigOptions(
  model: v2.Model,
  tiers: readonly v2.ModelServiceTier[],
  context: CodexCatalogContext,
): SessionConfigOption[] {
  const options: SessionConfigOption[] = []
  const defaults = context.requirements?.models?.newThread
  const efforts = model.supportedReasoningEfforts ?? []
  if (efforts.length > 0) {
    const offered = (value: string | null | undefined): value is string =>
      !!value && efforts.some((option) => option.reasoningEffort === value)
    options.push({
      type: 'select',
      id: CODEX_CONFIG.effort,
      name: 'Reasoning effort',
      category: 'effort',
      description: 'How much Codex reasons before it answers.',
      currentValue: offered(defaults?.modelReasoningEffort)
        ? defaults.modelReasoningEffort
        : offered(model.defaultReasoningEffort)
          ? model.defaultReasoningEffort
          : '',
      options: efforts.map((option) => ({
        value: option.reasoningEffort,
        name: option.reasoningEffort,
        ...(option.description ? { description: option.description } : {}),
      })),
    })
  }
  if (tiers.length > 0) {
    // No tier asked for is Codex's standard speed, unless the catalog names
    // a default tier, in which case nothing asked for *is* that tier.
    const catalogDefault = tiers.find((tier) => tier.id === model.defaultServiceTier)
    const values = [
      ...(catalogDefault ? [] : [{ value: '', name: 'Standard' }]),
      ...tiers.map((tier) => ({
        value: tier.id,
        name: tier.name || tier.id,
        ...(tier.description ? { description: tier.description } : {}),
      })),
    ]
    const managed = defaults?.serviceTier
    options.push({
      type: 'select',
      id: CODEX_CONFIG.serviceTier,
      name: 'Speed',
      category: 'service_tier',
      description: 'Faster service tiers use more of your plan.',
      currentValue: values.some((value) => value.value === managed)
        ? (managed as string)
        : (catalogDefault?.id ?? ''),
      options: values,
    })
  }
  return options
}

/** `upgrade` and `upgradeInfo`, in the composer's words. Codex's retirement
 * time is Unix seconds. */
export function codexModelUpgrade(model: v2.Model): ModelUpgrade | undefined {
  const info = model.upgradeInfo
  const modelId = info?.model ?? model.upgrade
  if (!modelId) return undefined
  return {
    modelId,
    ...(info?.upgradeCopy ? { message: info.upgradeCopy } : {}),
    ...(info?.modelLink ? { link: info.modelLink } : {}),
    ...(info?.retirementAt != null
      ? { retiresAt: new Date(info.retirementAt * 1000).toISOString() }
      : {}),
  }
}

const POLICY_REASON = 'Not allowed by a Codex policy your administrator manages.'

/** The access presets and settings a managed policy (`configRequirements`),
 * the permission profiles or a switched-off feature rule out.
 *
 * Every preset is checked against the approval policies, reviewers and
 * sandbox modes the policy allows, and against Codex's own built-in
 * permission profiles, which say what the effective requirements allow.
 * Web search modes the policy does not allow are blocked on their setting.
 * `undefined` requirements mean the CLI could not say; `null` means it said
 * there is no policy. */
export function codexPolicy(args: {
  requirements?: v2.ConfigRequirements | null
  permissionProfiles?: readonly v2.PermissionProfileSummary[]
  features?: CodexFeatures
}): ProviderPolicy {
  const requirements = args.requirements ?? null
  const blockedModes: ProviderPolicyBlock[] = []
  const profileAllowed = new Map(
    (args.permissionProfiles ?? []).map((profile) => [profile.id, profile.allowed]),
  )
  for (const preset of CODEX_PRESETS) {
    const reason = presetBlocked(preset, requirements, profileAllowed, args.features)
    if (reason) blockedModes.push({ id: preset, reason })
  }
  const blockedConfigValues: NonNullable<ProviderPolicy['blockedConfigValues']> = []
  const webSearch = requirements?.allowedWebSearchModes
  if (webSearch)
    for (const mode of WEB_SEARCH_MODES)
      if (!webSearch.includes(mode))
        blockedConfigValues.push({ configId: CODEX_CONFIG.webSearch, id: mode, reason: POLICY_REASON })
  if (requirements?.featureRequirements?.fast_mode === false)
    blockedConfigValues.push({
      configId: CODEX_CONFIG.serviceTier,
      id: CODEX_FAST_SERVICE_TIER,
      reason: POLICY_REASON,
    })
  return {
    ...(blockedModes.length > 0 ? { blockedModes } : {}),
    ...(blockedConfigValues.length > 0 ? { blockedConfigValues } : {}),
  }
}

const CODEX_PRESETS: readonly CodexAccessPreset[] = [
  'supervised',
  'auto-accept-edits',
  'auto',
  'full-access',
]

const WEB_SEARCH_MODES: readonly WebSearchMode[] = ['disabled', 'cached', 'indexed', 'live']

/** Codex's built-in permission profile that grants what each sandbox mode
 * does (`permissionProfile/list`, _probed_ on 0.170). */
const SANDBOX_PROFILE: Record<v2.SandboxMode, string> = {
  'read-only': ':read-only',
  'workspace-write': ':workspace',
  'danger-full-access': ':danger-full-access',
}

function presetBlocked(
  preset: CodexAccessPreset,
  requirements: v2.ConfigRequirements | null,
  profileAllowed: ReadonlyMap<string, boolean>,
  features: CodexFeatures | undefined,
): string | undefined {
  const access = codexAccess(preset)
  const approvals = requirements?.allowedApprovalPolicies
  if (approvals && !approvals.some((policy) => policy === access.approvalPolicy)) return POLICY_REASON
  const reviewers = requirements?.allowedApprovalsReviewers
  if (reviewers && !reviewers.includes(access.approvalsReviewer)) return POLICY_REASON
  const sandboxes = requirements?.allowedSandboxModes
  if (sandboxes && !sandboxes.includes(access.sandbox)) return POLICY_REASON
  if (profileAllowed.get(SANDBOX_PROFILE[access.sandbox]) === false) return POLICY_REASON
  if (access.approvalsReviewer === 'auto_review') {
    if (requirements?.featureRequirements?.guardian_approval === false) return POLICY_REASON
    if (features?.guardian_approval === false)
      return 'Auto review is turned off in your Codex config (`guardian_approval`).'
  }
  return undefined
}
