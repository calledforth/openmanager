import { useMemo, useState } from 'react'
import {
  favoriteModelKey,
  toggleFavoriteModel,
  useQuestionFlow,
  type ComposerChoice,
  type FavoriteModelKey,
  type PendingQuestion,
  type PlanRow,
  type ProviderModelGroup,
} from '@openmanager/app-core/logic'

import type { HomeSession } from '../home/rows'
import { ComposerSurface } from './ComposerSurface'
import {
  choiceLabel,
  currentModelLabel,
  permissionChoices,
  primaryAction,
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
      { id: 'opus', name: 'Opus', description: 'Opus 5.5 · Best for complex work' },
      { id: 'fable', name: 'Fable', description: 'Fable 5.1 · Fast and sharp' },
      { id: 'sonnet', name: 'Sonnet', description: 'Sonnet 5.5 · Everyday tasks' },
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
  },
]

const MODES: ComposerChoice[] = [
  { id: 'default', name: 'Default', description: 'Asks before anything dangerous.' },
  { id: 'acceptEdits', name: 'Accept edits' },
  { id: 'plan', name: 'Plan', description: 'Explores and proposes a plan. Runs no tools.' },
  {
    id: 'bypassPermissions',
    name: 'Bypass permissions',
    description: 'Runs every tool without asking.',
  },
]

const EFFORTS: ComposerChoice[] = [
  { id: 'low', name: 'Low' },
  { id: 'medium', name: 'Medium' },
  { id: 'high', name: 'High' },
  { id: 'max', name: 'Max' },
]

const SETTINGS: SessionConfigOption[] = [
  {
    type: 'select',
    id: 'context_window',
    name: 'Context window',
    currentValue: '200k',
    options: [
      { value: '200k', name: '200k' },
      { value: '1m', name: '1M' },
    ],
  },
  { type: 'boolean', id: 'fast_mode', name: 'Fast mode', currentValue: false },
] as SessionConfigOption[]

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

/**
 * The composer on a sample session (no environment paired): the same views
 * over sample picks, so the dock, the sheets and the prompts can be seen and
 * tried. Picks change here only; nothing is sent, and every answer says so.
 */
export function FixtureComposer({
  session,
  ui,
}: {
  session: HomeSession | undefined
  ui: ComposerUi
}) {
  const providerId = (session?.providerId ?? 'claude') as ProviderId
  const group = GROUPS.find((entry) => entry.providerId === providerId) ?? GROUPS[0]!
  const [text, setText] = useState('')
  const [modelId, setModelId] = useState(group.models[0]!.id)
  const [modeId, setModeId] = useState('default')
  const [effort, setEffort] = useState('high')
  const [settings, setSettings] = useState(SETTINGS)
  const [favorites, setFavorites] = useState<FavoriteModelKey[]>(() => [
    favoriteModelKey(providerId, group.models[0]!.id),
  ])
  const [note, setNote] = useState<string | null>(null)
  const kind = promptKindOf(session)
  const flow = useQuestionFlow(kind === 'question' ? QUESTION : null, () => {
    setNote(SAMPLE_REASON)
  })
  const isStreaming = session?.status === 'running'

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

  const model: ComposerModel = {
    picks: {
      providerId,
      modelLabel: currentModelLabel(GROUPS, providerId, modelId),
      mode: { id: modeId, label: choiceLabel(MODES, modeId) },
      effort: { id: effort, label: choiceLabel(EFFORTS, effort) },
      usagePercent: isStreaming ? 38 : 12,
      lockedReason: null,
    },
    groups: GROUPS,
    currentModelId: modelId,
    canChangeProvider: false,
    modeChoices: MODES,
    effortChoices: EFFORTS,
    settings,
    slashCommands: [
      { name: 'review', description: 'Review the current diff' },
      { name: 'compact', description: 'Summarise the conversation so far' },
      { name: 'init', description: 'Write a CLAUDE.md for this project' },
    ],
    favorites,
    text,
    placeholder: kind === 'plan' ? 'Describe what should change in the plan…' : 'Ask anything…',
    images: [],
    attach: { enabled: false, reason: SAMPLE_REASON },
    primary: primaryAction({
      isStreaming,
      canInterrupt: false,
      hasContent: text.trim().length > 0,
      sending: false,
      uploading: false,
      unavailable: SAMPLE_REASON,
      sendBlockedReason: null,
      imageProblem: null,
      planReview: kind === 'plan',
      hasImages: false,
    }),
    isStreaming,
    notice: null,
    unsynced: null,
    prompt,
    setText,
    send: () => setNote(SAMPLE_REASON),
    interrupt: () => setNote(SAMPLE_REASON),
    attachPhoto: () => setNote(SAMPLE_REASON),
    removeImage: () => undefined,
    pickModel: (_provider, id) => setModelId(id),
    pickMode: setModeId,
    pickEffort: setEffort,
    setSetting: (configId, value) =>
      setSettings((current) =>
        current.map((option) =>
          option.id === configId
            ? ({ ...option, currentValue: value } as SessionConfigOption)
            : option,
        ),
      ),
    toggleFavorite: (key) => setFavorites((current) => toggleFavoriteModel(current, key)),
  }

  return <ComposerSurface model={model} ui={ui} />
}
