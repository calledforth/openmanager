import { useCallback, useMemo, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { CircleNotchIcon, ClockIcon, ImageIcon, XIcon } from '@phosphor-icons/react'
import type { SessionConfigOption } from '@agentpack/contract'
import type {
  EnvironmentState,
  QueuedMessage,
  SessionComposerState,
  ThreadQueue,
  ThreadQueuePause,
} from '@openmanager/environment-client'
import { Tooltip } from '../ui/Tooltip'
import { useActiveThreadState } from '../../providers/active-thread-provider'
import {
  useEnvironmentClientOptional,
  useEnvironmentState,
  useThreadQueue,
} from '../../providers/environment-client'
import { effortConfigOption } from './modelConfig'
import { modelLabel } from './modelLabel'

/** Why a queue waits for the user, as its header says it. */
export const QUEUE_PAUSE_REASON: Record<ThreadQueuePause, string> = {
  failure: 'the turn failed',
  restart: 'the server restarted',
}

/** What a waiting message says, on one line: its text, else that it is only images. */
export function queuedMessagePreview(item: Pick<QueuedMessage, 'text' | 'artifactIds'>): string {
  const text = item.text.replace(/\s+/g, ' ').trim()
  if (text) return text
  const images = item.artifactIds?.length ?? 0
  return images === 1 ? 'An image' : `${images} images`
}

/** Ids providers give the reasoning-depth setting, when the chat lists none. */
const EFFORT_IDS = ['effort', 'reasoning_effort', 'reasoning']

/**
 * What a waiting message will run with that the composer is not set to now:
 * its model's name, its effort, or both. Null when it runs as the composer
 * reads; "Earlier settings" when only another setting differs.
 */
export function queuedSettingsLabel(
  settings: QueuedMessage['settings'],
  current: Pick<SessionComposerState, 'modelId' | 'configValues'> | null,
  names: {
    model: (modelId: string) => string
    /** The effort setting's id in this chat, and the name of one of its values. */
    effortId?: string
    effortValue?: (value: string) => string
  },
): string | null {
  const shown: string[] = []
  if (settings.modelId !== undefined && settings.modelId !== current?.modelId) {
    shown.push(names.model(settings.modelId))
  }
  const sent = settings.configValues ?? {}
  const now = current?.configValues ?? {}
  const effortId =
    names.effortId !== undefined && names.effortId in sent
      ? names.effortId
      : EFFORT_IDS.find((id) => id in sent)
  const effort = effortId !== undefined ? sent[effortId] : undefined
  if (effortId !== undefined && effort !== now[effortId] && typeof effort === 'string') {
    shown.push(names.effortValue?.(effort) ?? effort)
  }
  if (shown.length > 0) return shown.join(' · ')
  const otherDiffers = Object.entries(sent).some(([id, value]) => now[id] !== value)
  return otherDiffers ? 'Earlier settings' : null
}

const ROW_ACTION_CLASS =
  'flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded-full text-[var(--basis-text-muted)] transition-colors duration-100 hover:bg-hover hover:text-[var(--basis-text)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent'

/**
 * The open chat's waiting messages, just above the composer, in the order
 * they will run: each on one line, with a remove until it runs. A message
 * joining the running turn says so and cannot be taken back. When the queue
 * is paused, a header says why, with Resume.
 *
 * Every row is the environment's: a remove or a resume asks it, and the row
 * goes (or the header does) when the queue it sends back no longer has it.
 */
export function QueuedMessagesView({
  queue,
  settingsLabel,
  onRemove,
  onResume,
}: {
  queue: ThreadQueue
  settingsLabel: (item: QueuedMessage) => string | null
  onRemove: (queueItemId: string) => Promise<void>
  onResume: () => Promise<void>
}) {
  const reduceMotion = useReducedMotion()
  // Asked to go: the row keeps a spinner until the queue no longer has it, or
  // the environment refuses. It never leaves before the environment says so.
  const [removing, setRemoving] = useState<ReadonlySet<string>>(new Set())
  const [resuming, setResuming] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const remove = (queueItemId: string) => {
    setFailure(null)
    setRemoving((current) => new Set([...current, queueItemId]))
    onRemove(queueItemId).catch((error: unknown) => {
      setFailure(error instanceof Error && error.message ? error.message : 'Couldn’t remove it.')
      setRemoving((current) => new Set([...current].filter((id) => id !== queueItemId)))
    })
  }
  const resume = () => {
    setFailure(null)
    setResuming(true)
    onResume()
      .catch((error: unknown) =>
        setFailure(error instanceof Error && error.message ? error.message : 'Couldn’t resume.'),
      )
      .finally(() => setResuming(false))
  }

  const transition = { duration: reduceMotion ? 0 : 0.18, ease: [0.22, 1, 0.36, 1] as const }

  return (
    <AnimatePresence initial={false}>
      {queue.items.length > 0 ? (
        <motion.div
          key="queue"
          role="region"
          aria-label="Queued messages"
          initial={reduceMotion ? false : { opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 4 }}
          transition={transition}
          className="mb-1.5 flex"
        >
          <div className="flex w-[26rem] max-w-full flex-col rounded-[14px] bg-float py-0.5 shadow-float-rest">
            {queue.pausedBy ? (
              <div className="flex h-7 min-w-0 items-center gap-1.5 pl-2.5 pr-1">
                <span className="min-w-0 flex-1 truncate text-11-regular leading-none text-[var(--basis-text-muted)]">
                  Paused: {QUEUE_PAUSE_REASON[queue.pausedBy]}
                </span>
                <button
                  type="button"
                  onClick={resume}
                  disabled={resuming}
                  className="flex h-5 shrink-0 cursor-pointer items-center gap-1 rounded-full bg-hover px-2 text-11-regular leading-none text-[var(--basis-text)] transition-colors duration-100 hover:bg-active focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-60"
                >
                  {resuming ? (
                    <CircleNotchIcon className="h-3 w-3 animate-spin" aria-hidden="true" />
                  ) : null}
                  Resume
                </button>
              </div>
            ) : null}
            <ul className="custom-scrollbar flex max-h-[148px] flex-col overflow-y-auto">
              <AnimatePresence initial={false}>
                {queue.items.map((item) => {
                  const steering = item.delivery === 'steering'
                  const images = item.artifactIds?.length ?? 0
                  const label = settingsLabel(item)
                  const preview = queuedMessagePreview(item)
                  return (
                    <motion.li
                      key={item.queueItemId}
                      layout={reduceMotion ? false : 'position'}
                      initial={reduceMotion ? false : { opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 28 }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={transition}
                      className="flex min-w-0 items-center gap-1.5 overflow-hidden pl-2.5 pr-1"
                    >
                      {steering ? (
                        <span
                          className="todo-progress-loader shrink-0 text-[var(--basis-text-muted)]"
                          aria-hidden="true"
                        />
                      ) : (
                        <ClockIcon
                          className="h-3 w-3 shrink-0 text-[var(--basis-text-faint)]"
                          aria-hidden="true"
                        />
                      )}
                      <span
                        className="min-w-0 flex-1 truncate text-11-regular leading-5 text-[var(--basis-text)]"
                        title={item.text || undefined}
                      >
                        {preview}
                      </span>
                      {images > 0 && item.text.trim() ? (
                        <span
                          className="flex shrink-0 items-center gap-0.5 text-11-regular leading-none text-[var(--basis-text-faint)]"
                          aria-label={images === 1 ? '1 image' : `${images} images`}
                        >
                          <ImageIcon className="h-3 w-3" aria-hidden="true" />
                          {images}
                        </span>
                      ) : null}
                      {label ? (
                        <Tooltip content="Runs with what it was sent with">
                          <span className="max-w-[9rem] shrink-0 truncate rounded-full bg-hover px-1.5 text-[10px] leading-4 text-[var(--basis-text-muted)]">
                            {label}
                          </span>
                        </Tooltip>
                      ) : null}
                      {steering ? (
                        <span className="shrink-0 pr-1.5 text-11-regular leading-none text-[var(--basis-text-faint)]">
                          After the current step
                        </span>
                      ) : (
                        <Tooltip content="Remove">
                          <button
                            type="button"
                            className={ROW_ACTION_CLASS}
                            disabled={removing.has(item.queueItemId)}
                            aria-label={`Remove “${preview}”`}
                            onClick={() => remove(item.queueItemId)}
                          >
                            {removing.has(item.queueItemId) ? (
                              <CircleNotchIcon
                                className="h-3 w-3 animate-spin"
                                aria-hidden="true"
                              />
                            ) : (
                              <XIcon className="h-3 w-3" aria-hidden="true" />
                            )}
                          </button>
                        </Tooltip>
                      )}
                    </motion.li>
                  )
                })}
              </AnimatePresence>
            </ul>
            {failure ? (
              <p role="alert" className="px-2.5 pb-1 text-11-regular leading-4 text-red-400">
                {failure}
              </p>
            ) : null}
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}

/** The open chat's queue, for hosts backed by an environment that keeps one. */
export function SessionQueuedMessages() {
  const client = useEnvironmentClientOptional()
  return client ? <EnvironmentQueuedMessages /> : null
}

type SettingsContext = {
  composer: SessionComposerState | null
  models: ReadonlyArray<{ modelId: string; name: string; description?: string }>
  configOptions: readonly SessionConfigOption[] | undefined
}

const NO_MODELS: SettingsContext['models'] = []

function EnvironmentQueuedMessages() {
  const client = useEnvironmentClientOptional()!
  const { followUps } = useActiveThreadState()
  const threadId = useEnvironmentState(
    useCallback((state: EnvironmentState) => state.activeThreadId, []),
  )
  const fullQueue = useThreadQueue()
  // Steered messages show in the conversation, where they will land.
  const steered = useEnvironmentState(
    useCallback(
      (state: EnvironmentState) =>
        state.activeThreadId ? state.threads[state.activeThreadId]?.steeredQueueIds : undefined,
      [],
    ),
  )
  const queue = useMemo(
    () =>
      steered
        ? {
            ...fullQueue,
            items: fullQueue.items.filter((item) => !steered.includes(item.queueItemId)),
          }
        : fullQueue,
    [fullQueue, steered],
  )
  // What the composer is set to now, and the names to say a difference in.
  const composer = useEnvironmentState(
    useCallback(
      (state: EnvironmentState) =>
        state.activeSessionId ? (state.sessions[state.activeSessionId]?.composer ?? null) : null,
      [],
    ),
  )
  const models = useEnvironmentState(
    useCallback((state: EnvironmentState) => {
      const providerId = state.activeSessionId
        ? state.sessions[state.activeSessionId]?.providerId
        : undefined
      return (providerId && state.providers[providerId]?.profile?.availableModels) || NO_MODELS
    }, []),
  )
  const configOptions = useEnvironmentState(
    useCallback(
      (state: EnvironmentState) =>
        state.activeThreadId
          ? (state.threads[state.activeThreadId]?.listing.configOptions as
              SessionConfigOption[] | undefined)
          : undefined,
      [],
    ),
  )
  if (!threadId || !followUps || !client.supports('queueMessage')) return null
  const context: SettingsContext = { composer, models, configOptions }
  return (
    <QueuedMessagesView
      // Per chat: a remove pending in one must not show as pending in the next.
      key={threadId}
      queue={queue}
      settingsLabel={(item) => settingsLabelIn(context, item)}
      onRemove={followUps.removeQueued}
      onResume={followUps.resume}
    />
  )
}

function settingsLabelIn(context: SettingsContext, item: QueuedMessage): string | null {
  const effort = effortConfigOption(context.configOptions)
  return queuedSettingsLabel(item.settings, context.composer, {
    model: (modelId) => {
      const model = context.models.find((entry) => entry.modelId === modelId)
      return model ? modelLabel(model.name, model.description) : modelId
    },
    ...(effort
      ? {
          effortId: effort.id,
          effortValue: (value: string) =>
            effort.options.find((option) => option.value === value)?.name ?? value,
        }
      : {}),
  })
}
