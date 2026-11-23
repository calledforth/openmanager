import { useMemo, useState } from 'react'
import {
  configurableSessionOptions,
  effortDisplayName,
  favoriteModelKey,
  toggleFavoriteModel,
  useEnterWhileRunning,
  useQuestionFlow,
  type ComposerChoice,
  type FavoriteModelKey,
  type PendingQuestion,
  type PlanRow,
  type ProviderModelGroup,
} from '@openmanager/app-core/logic'

import type { HomeSession } from '../home/rows'
import type { FixtureFollowUps } from '../session/fixture-thread'
import { ComposerSurface } from './ComposerSurface'
import { fastOn } from './controls-view'
import {
  choiceLabel,
  currentModelLabel,
  permissionChoices,
  primaryAction,
  stopAction,
  whileBusyOf,
  type ComposerModel,
  type ComposerPrompt,
  type ProviderId,
  type SessionConfigOption,
} from './model'
import type { ComposerUi } from './ui-state'

/** Why a sample session sends nothing. */
export const SAMPLE_REASON = 'A sample session: pair an environment to send'

const GROUPS: ProviderModelGroup[] = [
  {
    providerId: 'claude',
    providerName: 'Claude Code',
    models: [
      {
        id: 'opus',
        name: 'Opus',
        description: 'Opus 5.5 · Best for complex work',
        contextWindowTokens: 1_000_000,
        supportsFastMode: true,
      },
      { id: 'fable', name: 'Fable', description: 'Fable 5.1 · Fast and sharp' },
      {
        id: 'sonnet',
        name: 'Sonnet',
        description: 'Sonnet 5.5 · Everyday tasks',
        contextWindowTokens: 200_000,
      },
    ],
  },
  {
    providerId: 'cursor',
    providerName: 'Cursor',
    models: [
      { id: 'composer-2.5', name: 'composer-2.5' },
      { id: 'grok-4.5', name: 'grok-4.5', description: 'fast' },
    ],
  },
  {
    providerId: 'opencode',
    providerName: 'OpenCode',
    models: [{ id: 'big-pickle', name: 'Big Pickle' }],
    acceptsTypedIds: true,
  },
  {
    providerId: 'codex',
    providerName: 'Codex',
    models: [
      {
        id: 'gpt-6.1-sol',
        name: 'gpt-6.1-sol',
        description: 'Frontier agentic coding',
        supportsFastMode: true,
        contextWindowTokens: 400_000,
      },
      { id: 'gpt-6-luna', name: 'gpt-6-luna', description: 'Fast and cheap' },
      { id: 'gpt-5.5', name: 'gpt-5.5', supportsFastMode: true },
    ],
  },
]

/** What a sample provider offers beside its models: modes, effort levels, settings. */
interface SampleProvider {
  modes: ComposerChoice[]
  mode: string
  efforts: ComposerChoice[]
  effort: string
  settings: SessionConfigOption[]
}

const CODEX_POLICY = 'Not allowed by a Codex policy your administrator manages.'

const SAMPLES: Record<string, SampleProvider> = {
  claude: {
    modes: [
      { id: 'default', name: 'Default', description: 'Asks before anything dangerous.' },
      { id: 'acceptEdits', name: 'Accept edits' },
      { id: 'plan', name: 'Plan', description: 'Explores and proposes a plan. Runs no tools.' },
      {
        id: 'bypassPermissions',
        name: 'Bypass permissions',
        description: 'Runs every tool without asking.',
      },
    ],
    mode: 'bypassPermissions',
    // Claude's bare level ids, as its catalog sends them.
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'].map((id) => ({ id, name: id })),
    effort: 'high',
    settings: [
      {
        type: 'select',
        id: 'context_window',
        name: 'Context window',
        currentValue: '1m',
        options: [
          { value: '200k', name: '200k' },
          { value: '1m', name: '1M' },
        ],
      },
      {
        type: 'boolean',
        id: 'fast_mode',
        name: 'Fast mode',
        description: 'Faster output, at a higher price.',
        currentValue: false,
      },
    ] as SessionConfigOption[],
  },
  codex: {
    modes: [
      {
        id: 'supervised',
        name: 'Supervised',
        description: 'Read-only sandbox. Asks before running anything it does not trust.',
      },
      {
        id: 'auto-accept-edits',
        name: 'Auto-accept edits',
        description: 'Edits inside the workspace go through. Anything that leaves asks.',
      },
      {
        id: 'auto',
        name: 'Auto',
        description: 'A reviewer agent answers what would ask you.',
      },
      {
        id: 'full-access',
        name: 'Full access',
        description: 'No sandbox and no approvals. Use with care.',
        disabledReason: CODEX_POLICY,
      },
    ],
    mode: 'auto',
    efforts: [
      { id: 'low', name: 'Low', description: 'Fast answers to simple asks.' },
      { id: 'medium', name: 'Medium', description: 'Balances speed and depth.' },
      { id: 'high', name: 'High', description: 'Thinks hard about complex work.' },
      { id: 'xhigh', name: 'Extra high', description: 'The deepest reasoning it has.' },
    ],
    effort: 'xhigh',
    settings: [
      {
        type: 'select',
        id: 'service_tier',
        name: 'Speed',
        category: 'service_tier',
        description: 'Faster service tiers use more of your plan.',
        currentValue: 'priority',
        options: [
          { value: 'default', name: 'Standard' },
          { value: 'priority', name: 'Fast', description: 'About 1.5x faster, at 2x the usage.' },
        ],
      },
      {
        type: 'select',
        id: 'web_search',
        name: 'Web search',
        category: 'web_search',
        description: 'Whether and how Codex searches the web. Kept per chat.',
        currentValue: 'cached',
        options: [
          { value: 'disabled', name: 'Off' },
          { value: 'cached', name: 'Cached' },
          { value: 'live', name: 'Live' },
        ],
      },
    ] as SessionConfigOption[],
  },
  cursor: {
    modes: [
      { id: 'agent', name: 'Agent' },
      { id: 'plan', name: 'Plan' },
    ],
    mode: 'agent',
    efforts: [],
    effort: '',
    settings: [
      { type: 'boolean', id: 'thinking', name: 'Thinking', currentValue: true },
    ] as SessionConfigOption[],
  },
  opencode: {
    modes: [
      { id: 'build', name: 'Build' },
      { id: 'plan', name: 'Plan' },
    ],
    mode: 'build',
    efforts: [],
    effort: '',
    settings: [],
  },
}

/** Build / Plan, as the shared mode pill offers a provider with only those two. */
function modesOf(sample: SampleProvider): ComposerChoice[] {
  const plan = sample.modes.find((mode) => mode.id === 'plan')
  const others = sample.modes.filter((mode) => mode.id !== 'plan')
  if (plan && others.length === 1 && sample.modes.length === 2) {
    return [
      { id: others[0]!.id, name: 'Build' },
      { id: 'plan', name: 'Plan' },
    ]
  }
  return sample.modes
}

const QUESTION: PendingQuestion = {
  requestId: 'fixture-question',
  questions: [
    {
      questionId: 'q1',
      prompt: 'Which page should the pricing tiers link to?',
      options: [
        { optionId: 'checkout', label: 'Checkout', description: 'Straight to payment' },
        { optionId: 'contact', label: 'Contact sales' },
        { optionId: 'docs', label: 'The docs' },
      ],
      allowFreeText: true,
    },
    {
      questionId: 'q2',
      prompt: 'Which tiers show a yearly price?',
      allowMultiple: true,
      options: [
        { optionId: 'starter', label: 'Starter' },
        { optionId: 'team', label: 'Team' },
        { optionId: 'enterprise', label: 'Enterprise' },
      ],
    },
  ],
  createdAt: 0,
  updatedAt: 0,
}

const PLAN: PlanRow = {
  requestId: 'fixture-plan',
  name: 'Portfolio site: projects grid and contact form',
  overview: 'A static site with a filterable projects grid, case-study pages and a contact form.',
  markdown:
    '## Approach\n\nStart from the existing Astro shell, add a `projects` collection and render it as a grid with tag filters.\n\n- Case studies get their own route\n- The form posts to the existing Worker',
  todos: [
    { id: 't1', content: 'Add the projects collection and its schema', status: 'pending' },
    { id: 't2', content: 'Grid with tag filters', status: 'pending' },
    { id: 't3', content: 'Contact form posting to the Worker', status: 'pending' },
  ],
  status: 'pending',
  createdAt: 0,
  updatedAt: 0,
} as PlanRow

/** The sample sessions' pending requests, by session: what the composer becomes there. */
function promptKindOf(session: HomeSession | undefined): 'permission' | 'question' | 'plan' | null {
  if (!session) return null
  if (session.externalId === 's-portfolio') return 'plan'
  if (session.status === 'waiting')
    return session.waitingOn === 'question' ? 'question' : 'permission'
  return null
}

/** The sample picks of one provider, from its own sample. */
function picksState(providerId: ProviderId) {
  const sample = SAMPLES[providerId] ?? SAMPLES.claude!
  const group = GROUPS.find((entry) => entry.providerId === providerId) ?? GROUPS[0]!
  return {
    providerId,
    modelId: group.models[0]!.id,
    modeId: sample.mode,
    effort: sample.effort,
    settings: sample.settings,
  }
}

/**
 * A sample composer's model: the same views over sample picks, so the dock,
 * the tray, the sheets and the prompts can be seen and tried without an
 * environment. Picks change here only; nothing is sent, and every answer says
 * so. `draft` is a new session's: it can move between providers, and its
 * picks follow the provider picked.
 */
export function useFixtureComposerModel({
  session,
  providerId: initialProvider,
  draft = false,
  initialText = '',
  followUps,
}: {
  session?: HomeSession
  providerId?: ProviderId
  draft?: boolean
  /** What the field opens with (a sample move's carried text). */
  initialText?: string
  /** The sample chat's queue: a message typed while it runs is queued or steered there. */
  followUps?: FixtureFollowUps
}): ComposerModel {
  const [choice] = useEnterWhileRunning()
  const [picks, setPicks] = useState(() =>
    picksState((initialProvider ?? session?.providerId ?? 'claude') as ProviderId),
  )
  const providerId = picks.providerId
  const sample = SAMPLES[providerId] ?? SAMPLES.claude!
  const [text, setText] = useState(initialText)
  const [favorites, setFavorites] = useState<FavoriteModelKey[]>(() => [
    favoriteModelKey('claude', 'opus'),
    favoriteModelKey('codex', 'gpt-6.1-sol'),
  ])
  const [note, setNote] = useState<string | null>(null)
  const kind = draft ? null : promptKindOf(session)
  const flow = useQuestionFlow(kind === 'question' ? QUESTION : null, () => {
    setNote(SAMPLE_REASON)
  })
  const isStreaming = !draft && session?.status === 'running'
  // A running sample chat takes follow-ups as a live one does; nothing else is sent.
  const whileBusy = followUps
    ? whileBusyOf({ busy: isStreaming, canSteer: true, choice, planReview: kind === 'plan' })
    : null
  const primary = primaryAction({
    isStreaming,
    canInterrupt: false,
    hasContent: text.trim().length > 0,
    sending: false,
    uploading: false,
    unavailable: whileBusy ? null : SAMPLE_REASON,
    sendBlockedReason: null,
    imageProblem: null,
    planReview: kind === 'plan',
    hasImages: false,
    whileBusy,
  })

  const prompt = useMemo((): ComposerPrompt | null => {
    if (kind === 'permission') {
      return {
        kind: 'permission',
        requestId: 'fixture-permission',
        title: 'Run pnpm --filter @openmanager/web test',
        detail: 'execute',
        choices: permissionChoices([
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'always', name: 'Always', kind: 'allow_always' },
          { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
        ]),
        answer: () => setNote(SAMPLE_REASON),
        answering: false,
        error: note,
      }
    }
    if (kind === 'question' && flow) {
      return { kind: 'question', requestId: QUESTION.requestId, title: null, flow, error: note }
    }
    if (kind === 'plan') {
      return {
        kind: 'plan',
        requestId: PLAN.requestId,
        plan: PLAN,
        build: () => setNote(SAMPLE_REASON),
        building: false,
        buildModeLabel: 'Default',
        error: note,
      }
    }
    return null
  }, [flow, kind, note])

  const modes = modesOf(sample)
  const efforts = sample.efforts.map((entry) => ({
    ...entry,
    name: effortDisplayName(entry.name),
  }))
  const settings = configurableSessionOptions(picks.settings)
  return {
    picks: {
      providerId,
      modelLabel: currentModelLabel(GROUPS, providerId, picks.modelId),
      mode: { id: picks.modeId, label: choiceLabel(modes, picks.modeId) },
      effort:
        efforts.length > 0
          ? {
              id: picks.effort,
              label: picks.effort ? choiceLabel(efforts, picks.effort) : 'Auto',
            }
          : null,
      usagePercent: draft ? null : isStreaming ? 38 : 12,
      fast: fastOn(settings),
      lockedReason: null,
    },
    groups: GROUPS,
    currentModelId: picks.modelId,
    canChangeProvider: draft,
    modeChoices: modes,
    effortChoices: efforts,
    settings,
    slashCommands:
      providerId === 'codex'
        ? [
            { name: 'review', description: 'Review the current changes' },
            { name: 'compact', description: 'Summarise the conversation to free up context' },
            { name: 'init', description: 'Write an AGENTS.md for this project' },
          ]
        : [
            { name: 'review', description: 'Review the current diff' },
            { name: 'compact', description: 'Summarise the conversation so far' },
            { name: 'init', description: 'Write a CLAUDE.md for this project' },
          ],
    favorites,
    text,
    placeholder: draft
      ? 'What should we build?'
      : kind === 'plan'
        ? 'Describe what should change in the plan…'
        : 'Ask anything…',
    images: [],
    uploading: false,
    attach: { enabled: false, reason: SAMPLE_REASON },
    primary,
    stop:
      isStreaming && primary.kind !== 'stop' && primary.kind !== 'send'
        ? stopAction({ canInterrupt: false, unavailable: SAMPLE_REASON })
        : null,
    isStreaming,
    notice: null,
    unsynced: null,
    prompt,
    setText,
    send: (action) => {
      if (!action || !followUps) {
        setNote(SAMPLE_REASON)
        return
      }
      const typed = text.trim()
      if (!typed) return
      followUps[action](typed)
      setText('')
    },
    interrupt: () => setNote(SAMPLE_REASON),
    attachPhoto: () => setNote(SAMPLE_REASON),
    removeImage: () => undefined,
    pickModel: (provider, id) =>
      setPicks((current) =>
        provider === current.providerId
          ? { ...current, modelId: id }
          : draft
            ? { ...picksState(provider), modelId: id }
            : current,
      ),
    pickMode: (id) => setPicks((current) => ({ ...current, modeId: id })),
    pickEffort: (id) => setPicks((current) => ({ ...current, effort: id })),
    setSetting: (configId, value) =>
      setPicks((current) => ({
        ...current,
        settings: current.settings.map((option) =>
          option.id === configId
            ? ({ ...option, currentValue: value } as SessionConfigOption)
            : option,
        ),
      })),
    toggleFavorite: (key) => setFavorites((current) => toggleFavoriteModel(current, key)),
  }
}

/**
 * The composer on a sample session (no environment paired): the same views
 * over sample picks, so the dock, the sheets and the prompts can be seen and
 * tried. Picks change here only; nothing is sent, and every answer says so.
 */
export function FixtureComposer({
  session,
  ui,
  followUps,
}: {
  session: HomeSession | undefined
  ui: ComposerUi
  /** The sample chat's queue: a message typed while it runs is queued or steered there. */
  followUps?: FixtureFollowUps
}) {
  const model = useFixtureComposerModel({
    ...(session ? { session } : {}),
    ...(followUps ? { followUps } : {}),
  })
  return <ComposerSurface model={model} ui={ui} />
}
