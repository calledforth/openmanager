import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api } from '@openmanager/convex/_generated/api'
import type { Id } from '@openmanager/convex/_generated/dataModel'
import type {
  PlanReviewOutcome,
  PromptAttachment,
  ProviderId,
  QuestionOutcome,
} from '@agentpack/contract'
import {
  reconstructSnapshot,
  type StreamChunk,
} from '@openmanager/shared/lib/stream-reconstruction'
import {
  StreamingMessagesStore,
  type MessagePart,
  type StreamHydrationSnapshot,
} from '@openmanager/app-core/lib/streaming-messages-store'
import type { UploadedImageAttachment } from '@openmanager/app-core/lib/attachments'
import { promptAttachment } from '@openmanager/app-core/lib/attachments'
import type { PermissionSelection } from '@openmanager/app-core/providers/permission-provider'
import {
  ActiveThreadStateContext,
  mergePersistedAndOptimisticMessages,
  shouldPreserveOptimisticMessages,
  type ActiveThreadDetails,
  type ActiveThreadStateValue,
  type MessageContentSnapshot,
  type MessageContentStore,
  type UIMessage,
} from '@openmanager/app-core/providers/active-thread-provider'
import type { TurnRuntimeMetadata } from '@openmanager/app-core/components/parts/turn-work-group'
import { createConvexWatchStore } from '../lib/convex-watch-store'
import { createRemoteStreamingStore } from '../lib/remote-stream-store'
import { usePlatformCapabilities } from '@openmanager/app-core/providers/platform-provider'
import { useSessionState } from '@openmanager/app-core/providers/session-provider'
import { useComposerState } from '@openmanager/app-core/providers/composer-provider'
import {
  recordRendererTelemetry,
  trackedConvexQuery,
  useTrackedMutation,
  useTrackedQuery,
} from '../lib/convex-telemetry'
export * from '@openmanager/app-core/providers/active-thread-provider'
export { StreamingMessagesStore } from '@openmanager/app-core/lib/streaming-messages-store'
export type { StreamHydrationSnapshot } from '@openmanager/app-core/lib/streaming-messages-store'

type ContentDoc = {
  content: string
  metadata?: { parts?: MessagePart[]; runtime?: TurnRuntimeMetadata }
} | null

/** Persisted message bodies as an external store over `messages.getContent`.
 * The Convex row is mapped once per result so subscribers get a stable snapshot. */
function createMessageContentStore(): MessageContentStore {
  return createConvexWatchStore<{ externalId: string }, MessageContentSnapshot | null>({
    name: 'messages.getContent',
    query: api.messages.getContent,
    argsFor: (externalId) => ({ externalId }),
    select: (raw) => {
      const doc = raw as unknown as ContentDoc
      if (!doc) return null
      return {
        content: doc.content,
        ...(doc.metadata?.parts ? { parts: doc.metadata.parts } : {}),
        ...(doc.metadata?.runtime ? { runtime: doc.metadata.runtime } : {}),
      }
    },
  })
}

/** Status of the job carrying an optimistic message, so a failed send can be
 * shown on the bubble. Watched here rather than per row so the rows stay
 * free of Convex. */
const optimisticJobStatus = createConvexWatchStore<
  { jobId: string },
  { status: string; lastError?: string } | null
>({
  name: 'jobs.getStatus.optimistic',
  query: api.jobs.getStatus,
  argsFor: (jobId) => ({ jobId }),
})

const EMPTY_MESSAGES: Array<{
  externalId: string
  role: string
  isFinal?: boolean
  sequenceNum: number
}> = []

// Rebuild a turn from its persisted chunks. The desktop reads these only to
// recover history it missed; subsequent tokens keep arriving over IPC, which is
// both faster and the only source once the chunks are swept.
async function hydrateStreamSnapshot(
  messageExternalId: string,
): Promise<StreamHydrationSnapshot | null> {
  const chunks = (await trackedConvexQuery(
    'streamChunks.getChunksSince.hydrate',
    api.streamChunks.getChunksSince,
    { messageExternalId, afterIndex: -1 },
  )) as StreamChunk[] | null
  if (!chunks?.length) return null
  const snapshot = reconstructSnapshot(chunks)
  return {
    parts: snapshot.parts as MessagePart[] | undefined,
    ...(snapshot.throughSeq !== undefined ? { throughSeq: snapshot.throughSeq } : {}),
  }
}

/** Host-backed active thread: the session record and message metadata from
 * Convex, live tokens over IPC into the streaming store, and every turn
 * command submitted as a desktop job. */
export function ActiveThreadStateProvider({ children }: { children: ReactNode }) {
  const { currentClientId, ensureProvider, providerDisplayName } = usePlatformCapabilities()
  const {
    activeSessionId,
    activeWorkspacePath,
    isSessionDraftOpen,
    pendingDraftSessionStart,
    adoptedDraftSessionId,
    providerIdForSession,
    beginDraftTurn,
    beginSessionTurn,
    attachTurnJob,
    failTurn,
  } = useSessionState()
  const { draftLaunchPreferences, sessionLaunchPreferences, recordSessionMode } = useComposerState()
  const [error, setError] = useState<string | null>(null)

  // The source is attached at construction so it is in place before the IPC
  // listener below can deliver the first event of an in-flight turn.
  const streamingStore = useMemo(() => {
    const store = new StreamingMessagesStore()
    store.setSnapshotSource(hydrateStreamSnapshot)
    return store
  }, [])
  const remoteStreamingStore = useMemo(() => createRemoteStreamingStore(), [])
  const messageContentStore = useMemo(() => createMessageContentStore(), [])
  const [jobErrors, setJobErrors] = useState<Record<string, string>>({})
  const [optimisticUserMessages, setOptimisticUserMessages] = useState<UIMessage[]>([])
  const previousActiveSessionIdRef = useRef(activeSessionId)

  const telemetryContext = useCallback(
    () => ({
      sessionExternalId: activeSessionId ?? undefined,
      workspacePath: activeWorkspacePath ?? undefined,
    }),
    [activeSessionId, activeWorkspacePath],
  )
  const submitJob = useTrackedMutation('jobs.submit', api.jobs.submit, telemetryContext)
  const persistPlanFeedback = useTrackedMutation(
    'messages.upsertFinalized.plan-feedback',
    api.messages.upsertFinalized,
  )
  const removeMessage = useTrackedMutation(
    'messages.removeByExternalId.plan-feedback',
    api.messages.removeByExternalId,
  )

  const rawSession = useTrackedQuery(
    'sessions.getByExternalId.active',
    api.sessions.getByExternalId,
    activeSessionId ? { externalId: activeSessionId } : 'skip',
  ) as
    | {
        externalId: string
        title?: string
        status: string
        clientId?: string
        providerId?: ProviderId
        parentExternalId?: string
      }
    | null
    | undefined

  const rawMessages = useTrackedQuery(
    'messages.listMetadata',
    api.messages.listMetadata,
    activeSessionId ? { sessionExternalId: activeSessionId } : 'skip',
  ) as typeof EMPTY_MESSAGES | undefined

  const messageList = rawMessages ?? EMPTY_MESSAGES
  const isMessagesLoading = !!activeSessionId && rawMessages === undefined
  const activeThreadDriven =
    (!!rawSession && !!currentClientId && rawSession.clientId === currentClientId) ||
    (!!activeSessionId && activeSessionId === adoptedDraftSessionId)
  const activeThread = useMemo<ActiveThreadDetails | null>(
    () =>
      rawSession
        ? {
            externalId: rawSession.externalId,
            title: rawSession.title,
            status: rawSession.status,
            clientId: rawSession.clientId,
            providerId: rawSession.providerId,
            parentExternalId: rawSession.parentExternalId,
            isDriven: activeThreadDriven,
          }
        : null,
    [activeThreadDriven, rawSession],
  )

  useEffect(() => {
    return window.electronAPI.onStreamToken((event) => {
      streamingStore.update(event)
    })
  }, [streamingStore])

  useEffect(() => {
    const finalIds = new Set(
      messageList.filter((message) => message.isFinal).map((message) => message.externalId),
    )
    if (finalIds.size === 0) return
    for (const messageId of finalIds) {
      streamingStore.remove(messageId)
    }
  }, [messageList, streamingStore])

  useEffect(() => {
    const previousSessionId = previousActiveSessionIdRef.current
    if (previousSessionId === activeSessionId) return
    previousActiveSessionIdRef.current = activeSessionId
    const preserveOptimisticMessages = shouldPreserveOptimisticMessages(
      previousSessionId,
      activeSessionId,
      adoptedDraftSessionId,
    )

    if (!preserveOptimisticMessages) {
      setOptimisticUserMessages((prev) => {
        for (const message of prev) {
          for (const attachment of message.optimisticAttachments ?? []) {
            URL.revokeObjectURL(attachment.previewUrl)
          }
        }
        return []
      })
    }
  }, [activeSessionId, adoptedDraftSessionId])

  const optimisticJobKey = optimisticUserMessages
    .map((message) => message.optimisticJobId)
    .filter((jobId): jobId is string => !!jobId)
    .join('\n')
  useEffect(() => {
    const jobIds = optimisticJobKey ? optimisticJobKey.split('\n') : []
    if (jobIds.length === 0) return
    const stops = jobIds.map((jobId) =>
      optimisticJobStatus.subscribe(jobId, () => {
        const status = optimisticJobStatus.get(jobId)
        if (status?.status !== 'failed') return
        const message = status.lastError ?? 'Failed to send'
        setJobErrors((prev) => (prev[jobId] === message ? prev : { ...prev, [jobId]: message }))
      }),
    )
    return () => stops.forEach((stop) => stop())
  }, [optimisticJobKey])

  const acknowledgeOptimisticMessage = useCallback((externalId: string) => {
    setOptimisticUserMessages((prev) => {
      const acknowledged = prev.find((message) => message.externalId === externalId)
      if (!acknowledged) return prev
      for (const attachment of acknowledged.optimisticAttachments ?? []) {
        URL.revokeObjectURL(attachment.previewUrl)
      }
      return prev.filter((message) => message.externalId !== externalId)
    })
  }, [])

  /** Submit the prompt as a desktop job: `start_session_with_message` for an
   * open draft, `send_message` for the active session. Resolves to the job id. */
  const submitPrompt = useCallback(
    async (
      content: string,
      userMessageId: string,
      attachments: PromptAttachment[],
    ): Promise<string | null> => {
      if (!activeWorkspacePath) return null
      setError(null)
      if (!currentClientId) {
        const error = new Error('Client identity unavailable')
        setError(error.message)
        throw error
      }
      if (!activeSessionId) {
        if (!isSessionDraftOpen || pendingDraftSessionStart) return null
        const {
          providerId: draftProviderId,
          preferredModelId,
          preferredModeId,
          preferredConfigValues,
        } = draftLaunchPreferences(activeWorkspacePath)
        beginDraftTurn()
        const ready = await ensureProvider(draftProviderId, activeWorkspacePath)
        if (!ready) {
          const error = new Error(
            `${providerDisplayName(draftProviderId)} is unavailable. Retry connection from the sidebar.`,
          )
          failTurn()
          setError(error.message)
          throw error
        }
        try {
          const jobId = (await submitJob({
            workspacePath: activeWorkspacePath,
            type: 'start_session_with_message',
            payload: JSON.stringify({
              workspacePath: activeWorkspacePath,
              content,
              attachments,
              userMessageId,
              providerId: draftProviderId,
              ...(preferredModelId ? { preferredModelId } : {}),
              ...(preferredModeId ? { preferredModeId } : {}),
              ...(preferredConfigValues ? { preferredConfigValues } : {}),
            }),
            clientId: currentClientId,
          })) as Id<'pending_jobs'>
          attachTurnJob(jobId)
          return jobId
        } catch (err) {
          failTurn()
          setError((err as Error).message)
          throw err
        }
      }
      beginSessionTurn()
      try {
        const providerId = providerIdForSession(activeSessionId)
        const { preferredConfigValues } = sessionLaunchPreferences(activeWorkspacePath, providerId)
        // Fire-and-forget, as everywhere else it is called: awaiting an IPC
        // round trip here delays the job submission behind a trace write.
        void recordRendererTelemetry({
          kind: 'trace',
          phase: 'mark',
          name: 'message.send',
          sessionExternalId: activeSessionId,
          workspacePath: activeWorkspacePath,
          details: content.slice(0, 120) || `${attachments.length} image attachment(s)`,
        })
        const jobId = (await submitJob({
          workspacePath: activeWorkspacePath,
          type: 'send_message',
          payload: JSON.stringify({
            workspacePath: activeWorkspacePath,
            sessionExternalId: activeSessionId,
            content,
            attachments,
            userMessageId,
            providerId,
            ...(preferredConfigValues ? { preferredConfigValues } : {}),
          }),
          clientId: currentClientId,
          sessionExternalId: activeSessionId,
        })) as Id<'pending_jobs'>
        attachTurnJob(jobId)
        return jobId
      } catch (err) {
        failTurn()
        setError((err as Error).message)
        throw err
      }
    },
    [
      activeSessionId,
      activeWorkspacePath,
      attachTurnJob,
      beginDraftTurn,
      beginSessionTurn,
      currentClientId,
      draftLaunchPreferences,
      ensureProvider,
      failTurn,
      isSessionDraftOpen,
      pendingDraftSessionStart,
      providerDisplayName,
      providerIdForSession,
      sessionLaunchPreferences,
      submitJob,
    ],
  )

  const sendMessage = useCallback(
    async (content: string, attachments: UploadedImageAttachment[] = []) => {
      const trimmed = content.trim()
      if (!trimmed && attachments.length === 0) return
      const maxSequenceNum = messageList.reduce(
        (max, message) => Math.max(max, message.sequenceNum),
        -1,
      )
      const localExternalId = `agent_usr_${crypto.randomUUID()}`
      const optimisticMessage: UIMessage = {
        externalId: localExternalId,
        role: 'user',
        isFinal: true,
        sequenceNum: maxSequenceNum + optimisticUserMessages.length + 1,
        optimisticContent: trimmed,
        optimisticAttachments: attachments,
        isOptimistic: true,
      }

      setOptimisticUserMessages((prev) => [...prev, optimisticMessage])
      try {
        const jobId = await submitPrompt(
          trimmed,
          localExternalId,
          attachments.map(promptAttachment),
        )
        if (jobId) {
          setOptimisticUserMessages((prev) =>
            prev.map((message) =>
              message.externalId === localExternalId
                ? { ...message, optimisticJobId: jobId }
                : message,
            ),
          )
        }
      } catch (error) {
        setOptimisticUserMessages((prev) =>
          prev.filter((message) => message.externalId !== localExternalId),
        )
        throw error
      }
    },
    [messageList, optimisticUserMessages.length, submitPrompt],
  )

  /** Submit a session-scoped job with the session's provider. Shared by the
   * one-shot commands below; errors surface through `error` and rethrow only
   * where the caller has cleanup to do. */
  const submitSessionJob = useCallback(
    async (sessionExternalId: string, type: string, payload: Record<string, unknown>) => {
      if (!activeWorkspacePath) return false
      if (!currentClientId) {
        setError('Client identity unavailable')
        return false
      }
      await submitJob({
        workspacePath: activeWorkspacePath,
        type,
        payload: JSON.stringify({
          workspacePath: activeWorkspacePath,
          sessionExternalId,
          ...payload,
          providerId: providerIdForSession(sessionExternalId),
        }),
        clientId: currentClientId,
        sessionExternalId,
      })
      return true
    },
    [activeWorkspacePath, currentClientId, providerIdForSession, submitJob],
  )

  const abortSession = useCallback(
    async (externalId: string) => {
      try {
        await submitSessionJob(externalId, 'abort', {})
      } catch (err) {
        setError((err as Error).message)
      }
    },
    [submitSessionJob],
  )

  const resolvePermission = useCallback(
    async (sessionExternalId: string, permissionId: string, selection: PermissionSelection) => {
      try {
        await submitSessionJob(sessionExternalId, 'resolve_permission', {
          permissionId,
          ...selection,
        })
      } catch (err) {
        setError((err as Error).message)
      }
    },
    [submitSessionJob],
  )

  const resolveQuestion = useCallback(
    async (sessionExternalId: string, requestId: string, outcome: QuestionOutcome) => {
      try {
        await submitSessionJob(sessionExternalId, 'resolve_question', { requestId, outcome })
      } catch (err) {
        setError((err as Error).message)
      }
    },
    [submitSessionJob],
  )

  const resolvePlan = useCallback(
    async (sessionExternalId: string, requestId: string, outcome: PlanReviewOutcome) => {
      if (!activeWorkspacePath) return
      if (!currentClientId) {
        setError('Client identity unavailable')
        return
      }
      const feedback = outcome.outcome === 'rejected' ? outcome.reason?.trim() : undefined
      const feedbackMessageId = feedback ? `agent_usr_plan_feedback_${crypto.randomUUID()}` : null
      try {
        if (feedback && feedbackMessageId) {
          await persistPlanFeedback({
            sessionExternalId,
            externalId: feedbackMessageId,
            content: feedback,
            role: 'user',
            parts: [{ type: 'text', id: `${feedbackMessageId}_text`, text: feedback }],
            runtimeMetadata: { kind: 'plan_feedback', planRequestId: requestId },
          })
        }
        await submitSessionJob(sessionExternalId, 'resolve_plan', { requestId, outcome })
      } catch (err) {
        if (feedbackMessageId) {
          await removeMessage({ externalId: feedbackMessageId }).catch(() => undefined)
        }
        setError((err as Error).message)
        throw err
      }
    },
    [activeWorkspacePath, currentClientId, persistPlanFeedback, removeMessage, submitSessionJob],
  )

  const buildPlan = useCallback(
    async (sessionExternalId: string, requestId: string, modeId?: string) => {
      if (!activeWorkspacePath) throw new Error('Workspace unavailable')
      if (!currentClientId) throw new Error('Client identity unavailable')
      const providerId = providerIdForSession(sessionExternalId)
      setError(null)
      beginSessionTurn()
      try {
        const userMessageId = `agent_usr_${crypto.randomUUID()}`
        const jobId = (await submitJob({
          workspacePath: activeWorkspacePath,
          type: 'build_plan',
          payload: JSON.stringify({
            workspacePath: activeWorkspacePath,
            sessionExternalId,
            requestId,
            content: 'Build the plan.',
            userMessageId,
            providerId,
            ...(modeId ? { modeId } : {}),
          }),
          clientId: currentClientId,
          sessionExternalId,
        })) as Id<'pending_jobs'>
        attachTurnJob(jobId)
        if (modeId) recordSessionMode(sessionExternalId, modeId)
      } catch (err) {
        failTurn()
        setError((err as Error).message)
        throw err
      }
    },
    [
      activeWorkspacePath,
      attachTurnJob,
      beginSessionTurn,
      currentClientId,
      failTurn,
      providerIdForSession,
      recordSessionMode,
      submitJob,
    ],
  )

  const messages: UIMessage[] = useMemo(() => {
    const persisted = messageList.map((message) => ({
      externalId: message.externalId,
      role: message.role,
      isFinal: message.isFinal,
      sequenceNum: message.sequenceNum,
    }))
    const merged = mergePersistedAndOptimisticMessages(persisted, optimisticUserMessages)
    return merged.map((message) => {
      const sendError = message.optimisticJobId ? jobErrors[message.optimisticJobId] : undefined
      return sendError ? { ...message, sendError } : message
    })
  }, [jobErrors, messageList, optimisticUserMessages])

  const value = useMemo<ActiveThreadStateValue>(
    () => ({
      activeSessionId,
      activeThread,
      activeThreadDriven,
      isMessagesLoading,
      messages,
      streamingStore,
      remoteStreamingStore,
      messageContentStore,
      error,
      acknowledgeOptimisticMessage,
      sendMessage,
      abortSession,
      resolvePermission,
      resolveQuestion,
      resolvePlan,
      buildPlan,
    }),
    [
      activeSessionId,
      activeThread,
      activeThreadDriven,
      isMessagesLoading,
      messages,
      streamingStore,
      remoteStreamingStore,
      messageContentStore,
      error,
      acknowledgeOptimisticMessage,
      sendMessage,
      abortSession,
      resolvePermission,
      resolveQuestion,
      resolvePlan,
      buildPlan,
    ],
  )

  return (
    <ActiveThreadStateContext.Provider value={value}>{children}</ActiveThreadStateContext.Provider>
  )
}
