/**
 * The composer's view model and the pure decisions behind it: how the dock
 * folds, what the send button is, how the model sheet groups its rows, which
 * of a permission's choices is the prominent one. The live composer and the
 * fixture one both build a `ComposerModel`; the views only draw it, so the
 * tests drive the same functions the screens do.
 */
import {
  favoriteModelKey,
  matchSlashCommands,
  modelHint,
  modelLabel,
  slashQueryFromText,
  type AcpSessionRuntimeState,
  type ComposerChoice,
  type FavoriteModelKey,
  type FollowUpAction,
  type PendingPermission,
  type PlanRow,
  type ProviderModelGroup,
  type QuestionFlow,
  type SessionConfigValue,
  type SlashCommandItem,
} from '@openmanager/app-core/logic'

/** The contract's types, as the shared logic carries them (the phone does not depend on the contract). */
export type ProviderId = ProviderModelGroup['providerId']
export type PermissionOption = NonNullable<PendingPermission['options']>[number]
export type SessionConfigOption = NonNullable<AcpSessionRuntimeState['configOptions']>[number]

/** How the docked composer is drawn. */
export type ComposerFold =
  /** B: the field with the picks row under it. */
  | 'rest'
  /** C: a turn runs; one summary chip inside the field, the stop button beside it. */
  | 'running'
  /** A pending interaction: the composer is the prompt. */
  | 'prompt'

/**
 * The dock's shape. It changes only when the session's state does (a turn
 * starts or ends, a request arrives or is answered) or the field comes into
 * use (`focused`, which brings back the picks a running turn folds away),
 * never with a token.
 */
export function composerFold(
  {
    isStreaming,
    prompt,
  }: {
    isStreaming: boolean
    prompt: ComposerPrompt | null
  },
  focused = false,
): ComposerFold {
  if (prompt) return 'prompt'
  return isStreaming && !focused ? 'running' : 'rest'
}

/**
 * The one button at the field's end: send; stop while a turn runs; and,
 * with something typed while the chat is busy, queue it for the next turn
 * or steer it into the running one (`queue` / `steer`), with Stop beside it.
 */
export interface PrimaryAction {
  kind: 'send' | 'stop' | FollowUpAction
  enabled: boolean
  /** Why it cannot be used now; null when it can. Said under the field and to a screen reader. */
  reason: string | null
  /** A send is on its way. */
  busy: boolean
  /** The other way to send what is typed while the chat is busy, offered on a long press. */
  alternate: FollowUpAction | null
}

/** What a busy chat does with a message: this phone's choice, and the other one when the turn can take it. */
export interface WhileBusy {
  enter: FollowUpAction
  alternate: FollowUpAction | null
}

/**
 * While the chat is busy, the phone's choice queues or steers, as web's
 * Enter does; steering needs a turn that can take it, so without one both
 * queue. Null while the chat is not busy, or a plan waits for review (the
 * field is then a change request).
 */
export function whileBusyOf(input: {
  busy: boolean
  canSteer: boolean
  /** This phone's choice (`useEnterWhileRunning`). */
  choice: FollowUpAction
  planReview: boolean
}): WhileBusy | null {
  if (!input.busy || input.planReview) return null
  if (!input.canSteer) return { enter: 'queue', alternate: null }
  return { enter: input.choice, alternate: input.choice === 'queue' ? 'steer' : 'queue' }
}

/**
 * Send and stop share one button, as on web. While a turn runs and nothing
 * is typed, the button stops it. With something typed while the chat is
 * busy, it queues or steers (`whileBusy`), and Stop stands beside it.
 * While a plan waits for review the turn is held for the answer and the
 * button sends the change request, as web's plan review does.
 */
export function primaryAction(input: {
  isStreaming: boolean
  /** The environment can stop this turn (it lists one, and takes `turn.interrupt`). */
  canInterrupt: boolean
  hasContent: boolean
  sending: boolean
  uploading: boolean
  /** Why nothing can be sent from here at all (not connected, a sample session); null when it can. */
  unavailable: string | null
  /** Why this draft cannot go as it stands (its provider is down). */
  sendBlockedReason: string | null
  /** Images are attached and the model cannot take them: why. */
  imageProblem: string | null
  /** A plan waits for review: text is feedback, and images cannot go with it. */
  planReview: boolean
  hasImages: boolean
  /** The chat is busy and takes follow-ups; see `whileBusyOf`. */
  whileBusy?: WhileBusy | null
}): PrimaryAction {
  const whileBusy = input.planReview ? null : (input.whileBusy ?? null)
  const following = !!whileBusy && (input.hasContent || input.sending || !input.isStreaming)
  if (input.isStreaming && !input.planReview && !following) {
    return { ...stopAction(input), alternate: null }
  }
  const reason =
    input.unavailable ??
    input.sendBlockedReason ??
    (input.uploading ? 'Waiting for the images to upload' : null) ??
    (input.planReview && input.hasImages
      ? 'Remove the images to ask for changes to the plan'
      : null) ??
    (input.hasImages ? input.imageProblem : null)
  return {
    kind: whileBusy ? whileBusy.enter : 'send',
    enabled: input.hasContent && !input.sending && reason === null,
    reason,
    busy: input.sending,
    alternate: whileBusy?.alternate ?? null,
  }
}

/** Stop, as the button or beside it: usable when the environment lists a turn it can stop. */
export function stopAction(input: {
  canInterrupt: boolean
  unavailable: string | null
}): Omit<PrimaryAction, 'alternate'> {
  return {
    kind: 'stop',
    enabled: input.canInterrupt && !input.unavailable,
    reason:
      input.unavailable ??
      (input.canInterrupt ? null : 'This environment cannot stop the turn from here'),
    busy: false,
  }
}

/** What the one button does when pressed, as it is drawn. */
export function pressPrimary(
  action: PrimaryAction,
  handlers: { send: (action?: FollowUpAction) => void; interrupt: () => void },
): void {
  if (!action.enabled) return
  if (action.kind === 'stop') handlers.interrupt()
  else if (action.kind === 'send') handlers.send()
  else handlers.send(action.kind)
}

/**
 * The long-press menu's two ways to send, the button's own first; null when
 * the button offers no choice (nothing typed, the turn ended, it cannot
 * steer). The menu is drawn only while this is not null, and closed when it
 * becomes null under it.
 */
export function followUpMenuOf(
  primary: Pick<PrimaryAction, 'kind' | 'alternate'>,
): [FollowUpAction, FollowUpAction] | null {
  if ((primary.kind !== 'queue' && primary.kind !== 'steer') || !primary.alternate) return null
  return [primary.kind, primary.alternate]
}

/** How a follow-up reads in the long-press menu and to a screen reader, as web's menu says it. */
export const FOLLOW_UP_LABEL: Record<FollowUpAction, { label: string; description: string }> = {
  queue: { label: 'Queue', description: 'Runs when this turn ends' },
  steer: { label: 'Steer', description: 'Cuts in once the current step ends' },
}

/** The picks as the dock's row and the tray show them. */
export interface ComposerPicks {
  providerId: ProviderId
  modelLabel: string
  /** Null hides the pick: the provider lists no modes. */
  mode: { id: string; label: string } | null
  /** Null hides the pick: the selected model has no effort control. */
  effort: { id: string; label: string } | null
  /** How full the context window is, 0–100; null when the session has not said. */
  usagePercent: number | null
  /** Fast mode, or a faster service tier, is on: the settings pick shows the bolt. */
  fast: boolean
  /** Why the picks cannot be changed from here; null when they can. */
  lockedReason: string | null
}

/** Never round a non-empty context down to a bare "0%", as web's meter does not. */
export function meterPercent(percent: number): number {
  const clamped = Math.min(100, Math.max(0, percent))
  return clamped > 0 && clamped < 1 ? 1 : Math.round(clamped)
}

/** The current model's name, as web's picker chip says it. */
export function currentModelLabel(
  groups: readonly ProviderModelGroup[],
  providerId: ProviderId,
  modelId: string,
): string {
  const group = groups.find((entry) => entry.providerId === providerId)
  const model = group?.models.find((entry) => entry.id === modelId) ?? group?.models[0]
  return model ? modelLabel(model.name, model.description) : modelId.split('/').pop() || 'Model'
}

/** The label a choice list gives `id`, or the id's last segment, as web's pill does. */
export function choiceLabel(choices: readonly ComposerChoice[], id: string): string {
  return choices.find((choice) => choice.id === id)?.name ?? id.split('/').pop() ?? id
}

/** Tab order after Favourites: web's picker order. */
const PROVIDER_ORDER: readonly string[] = ['claude', 'cursor', 'opencode', 'codex']

export interface ModelRow {
  key: FavoriteModelKey
  providerId: ProviderId
  modelId: string
  label: string
  hint?: string
  /** The window it reads, short ("200k", "1M"), when its catalog says. */
  context?: string
  /** Its catalog says it has a fast mode. */
  fast?: boolean
  /** Why it cannot be picked (its provider is down); the row stays listed and says so. */
  unavailableReason?: string
  favorite: boolean
  /** A model id typed in the search, for a provider that takes ids of its own. */
  typed?: boolean
}

/** One tab of the model sheet: Favourites, or a provider (shown by its mark only). */
export interface ModelTab {
  id: 'favorites' | ProviderId
  /** What a screen reader says for it. */
  label: string
}

export interface ModelSheetView {
  /** Favourites and one per provider; empty when there is only one place to look. */
  tabs: ModelTab[]
  /** The tab on screen; null with no tabs. */
  tab: ModelTab['id'] | null
  rows: ModelRow[]
  /** A search across every provider is on screen, not one tab. */
  searching: boolean
}

/** "1M", "200k": short enough to sit at a row's edge, as web's card says it. */
export function contextShort(tokens: number): string {
  if (tokens >= 1_000_000) return `${+(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`
  return String(tokens)
}

/**
 * The model sheet, as web's picker lays it out: Favourites and one tab per
 * provider in web's order, opening on the current model's provider. A
 * session can only change model within its provider, so other providers are
 * left out of a session's sheet. A query looks across every provider at once
 * (a phone's keyboard is too slow to search tab by tab); a provider that
 * takes typed ids offers what is typed as a model of its own, as web's does.
 */
export function modelSheetView({
  groups,
  currentProviderId,
  canChangeProvider,
  favorites,
  query,
  tab,
}: {
  groups: readonly ProviderModelGroup[]
  currentProviderId: ProviderId
  canChangeProvider: boolean
  favorites: readonly FavoriteModelKey[]
  query: string
  /** The tab picked; null opens on the current provider's. */
  tab: ModelTab['id'] | null
}): ModelSheetView {
  const rank = new Map(PROVIDER_ORDER.map((id, index) => [id, index]))
  const visible = groups
    .filter(
      (group) =>
        group.models.length > 0 && (canChangeProvider || group.providerId === currentProviderId),
    )
    .sort((a, b) => (rank.get(a.providerId) ?? 99) - (rank.get(b.providerId) ?? 99))
  const favoriteSet = new Set(favorites)
  const byKey = new Map<FavoriteModelKey, ModelRow>()
  const rowsOf = new Map<ProviderId, ModelRow[]>()
  for (const group of visible) {
    const rows = group.models.map((model): ModelRow => {
      const label = modelLabel(model.name, model.description)
      const hint = modelHint(model.name, model.description)
      const key = favoriteModelKey(group.providerId, model.id)
      const row: ModelRow = {
        key,
        providerId: group.providerId,
        modelId: model.id,
        label,
        ...(hint ? { hint } : {}),
        ...(model.contextWindowTokens ? { context: contextShort(model.contextWindowTokens) } : {}),
        ...(model.supportsFastMode ? { fast: true } : {}),
        ...(group.unavailableReason ? { unavailableReason: group.unavailableReason } : {}),
        favorite: favoriteSet.has(key),
      }
      byKey.set(key, row)
      return row
    })
    rowsOf.set(group.providerId, rows)
  }
  const favoriteRows = favorites.flatMap((key) => byKey.get(key) ?? [])
  const tabs: ModelTab[] =
    visible.length < 2
      ? []
      : [
          { id: 'favorites', label: 'Favourites' },
          ...visible.map((group) => ({ id: group.providerId, label: group.providerName })),
        ]
  // A tab that is gone (its provider went) falls back to the current provider's.
  const active: ModelTab['id'] | null =
    tabs.length === 0
      ? null
      : tabs.some((item) => item.id === tab)
        ? tab
        : tabs.some((item) => item.id === currentProviderId)
          ? currentProviderId
          : (tabs[1]?.id ?? 'favorites')

  const needle = query.trim().toLowerCase()
  if (needle) {
    const matches = [...rowsOf.values()]
      .flat()
      .filter(
        (row) =>
          row.label.toLowerCase().includes(needle) ||
          row.modelId.toLowerCase().includes(needle) ||
          (row.hint?.toLowerCase().includes(needle) ?? false),
      )
    // What is typed, as a model id of the provider on screen (or the only one).
    const typedGroup =
      active === null || active === 'favorites'
        ? visible.length === 1
          ? visible[0]
          : undefined
        : visible.find((group) => group.providerId === active)
    const typedId = query.trim()
    const typed: ModelRow[] =
      typedGroup?.acceptsTypedIds &&
      !typedGroup.unavailableReason &&
      !typedGroup.models.some((model) => model.id === typedId)
        ? [
            {
              key: favoriteModelKey(typedGroup.providerId, typedId),
              providerId: typedGroup.providerId,
              modelId: typedId,
              label: `Use “${typedId}”`,
              hint: `A ${typedGroup.providerName} model id`,
              favorite: false,
              typed: true,
            },
          ]
        : []
    return { tabs, tab: active, rows: [...matches, ...typed], searching: true }
  }
  const rows =
    active === null
      ? [...rowsOf.values()].flat()
      : active === 'favorites'
        ? favoriteRows
        : (rowsOf.get(active) ?? [])
  return { tabs, tab: active, rows, searching: false }
}

/** How a permission choice is filled: the first allow, the lasting allow, the rest quiet. */
export type ChoiceTone = 'primary' | 'secondary' | 'plain'

export interface PermissionChoice {
  optionId: string
  label: string
  tone: ChoiceTone
}

const OPTION_LABELS: Record<PermissionOption['kind'], string> = {
  allow_once: 'Allow',
  allow_always: 'Always allow',
  reject_once: 'Deny',
  reject_always: 'Always deny',
}

/**
 * The provider's own choices for a permission, in the order the request
 * lists them, under the provider's own names. Never a fixed allow/deny pair:
 * a request with no options has nothing to answer with here.
 */
export function permissionChoices(options: readonly PermissionOption[] | undefined) {
  let primaryTaken = false
  return (options ?? []).map((option): PermissionChoice => {
    let tone: ChoiceTone = 'plain'
    if (option.kind === 'allow_once' && !primaryTaken) {
      tone = 'primary'
      primaryTaken = true
    } else if (option.kind === 'allow_always') {
      tone = 'secondary'
    }
    return {
      optionId: option.optionId,
      label: option.name || OPTION_LABELS[option.kind] || option.kind,
      tone,
    }
  })
}

/** A pending request, as the composer becomes it. */
export type ComposerPrompt =
  | {
      kind: 'permission'
      requestId: string
      /** What is asked: the tool call's title, as the request names it. */
      title: string
      /** The tool's kind (`execute`, `edit`), when the request says. */
      detail: string | null
      choices: PermissionChoice[]
      answer: (optionId: string) => void
      /** An answer is on its way: every choice waits for it. */
      answering: boolean
      error: string | null
    }
  | {
      kind: 'question'
      requestId: string
      title: string | null
      flow: QuestionFlow
      error: string | null
    }
  | {
      kind: 'plan'
      requestId: string
      plan: PlanRow
      /** Accept the plan and build it in `buildModeLabel`. */
      build: () => void
      building: boolean
      buildModeLabel: string | null
      error: string | null
    }

/** An image in the field: uploading, kept with the draft, or not readable. */
export interface ComposerImage {
  id: string
  name: string
  /** What the thumbnail shows; absent while a kept image's bytes load or when they cannot be read. */
  uri?: string
  uploading?: boolean
  failed?: boolean
}

/** A photo taken on the phone, as the composer attaches it. */
export interface CapturedPhoto {
  uri: string
  name: string
  mimeType: string
}

/** Everything the composer views draw, and what they can ask. */
export interface ComposerModel {
  picks: ComposerPicks
  groups: ProviderModelGroup[]
  currentModelId: string
  canChangeProvider: boolean
  modeChoices: ComposerChoice[]
  effortChoices: ComposerChoice[]
  /** The settings behind the session's ⋯ menu: what the pills do not already draw. */
  settings: SessionConfigOption[]
  slashCommands: SlashCommandItem[]
  favorites: readonly FavoriteModelKey[]
  text: string
  placeholder: string
  images: ComposerImage[]
  attach: { enabled: boolean; reason: string | null }
  primary: PrimaryAction
  /** Stop beside the button while a turn runs and the button queues or steers; null otherwise. */
  stop: Omit<PrimaryAction, 'alternate'> | null
  isStreaming: boolean
  /** The last thing that went wrong: a refused send, a pick the environment did not take. */
  notice: string | null
  /**
   * Why the draft's latest edit has not reached the environment (offline,
   * refused, failed and being retried); null while it is saved or saving.
   */
  unsynced: string | null
  prompt: ComposerPrompt | null
  setText: (text: string) => void
  /** Sends what is typed; while the chat is busy, `action` says whether it waits or joins the turn. */
  send: (action?: FollowUpAction) => void
  interrupt: () => void
  attachPhoto: (photo: CapturedPhoto) => void
  removeImage: (id: string) => void
  pickModel: (providerId: ProviderId, modelId: string) => void
  pickMode: (modeId: string) => void
  pickEffort: (value: string) => void
  setSetting: (configId: string, value: SessionConfigValue) => void
  toggleFavorite: (key: FavoriteModelKey) => void
}

/**
 * The slash popup over the pulled-up field: the session's commands matching
 * a bare `/name` (the shared `slashQueryFromText` / `matchSlashCommands`),
 * none once dismissed or once there is nothing to match.
 */
export function slashPopupOf(
  text: string,
  commands: readonly SlashCommandItem[],
  dismissed: boolean,
): { query: string | null; matches: SlashCommandItem[] } {
  const query = slashQueryFromText(text)
  if (query === null || dismissed) return { query, matches: [] }
  return { query, matches: matchSlashCommands(commands, query) }
}

/** The row's gap between picks. */
export const PICK_GAP = 4
/** What the context meter takes: its number, its bar and its padding. */
export const METER_WIDTH = 80
/** Narrower than this, the model's name says too little: the meter goes first. */
export const MODEL_MIN_WIDTH = 84
/** The tray scrolls; a long name still stops somewhere. */
export const TRAY_MODEL_MAX = 200

/**
 * How the dock's picks row shares its width: mode and effort keep their
 * whole labels; the model's name takes what is left; when that would be too
 * little for it, the context meter steps aside before any label is cut.
 * Before the row has measured itself, everything shows and nothing is capped.
 */
export function roomFor({ row, fixed, meter }: { row: number; fixed: number; meter: boolean }): {
  model: number | undefined
  meter: boolean
} {
  if (row <= 0) return { model: undefined, meter }
  const free = row - fixed
  const showMeter = meter && free - METER_WIDTH >= MODEL_MIN_WIDTH
  return {
    model: Math.max(MODEL_MIN_WIDTH, free - (showMeter ? METER_WIDTH : 0)),
    meter: showMeter,
  }
}
