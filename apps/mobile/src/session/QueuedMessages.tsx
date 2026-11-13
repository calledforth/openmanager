import { ClockIcon, ImageIcon, XIcon } from 'phosphor-react-native'
import { useCallback, useRef, useState, useSyncExternalStore } from 'react'
import { ActivityIndicator, ScrollView, View } from 'react-native'
import Animated, { Easing, FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated'
import { QUEUE_PAUSE_REASON, queuedMessagePreview } from '@openmanager/app-core/logic'
import { selectActiveThread, type EnvironmentClient } from '@openmanager/environment-client'

import { AppText } from '../components/ui/AppText'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { Glass } from '../ui/Glass'
import { tap } from '../ui/haptics'
import { Press } from '../ui/Press'
import { EMPTY_WAITING_QUEUE, waitingQueueOf, type WaitingQueue } from './waiting-queue'

export { waitingQueueOf, type WaitingQueue } from './waiting-queue'

/** The page's own chat, while it is the one the client has open. */
function threadOf(client: Pick<EnvironmentClient, 'getState'>, sessionId: string) {
  const state = client.getState()
  return state.activeSessionId === sessionId ? selectActiveThread(state) : null
}

/** The page's waiting messages, and how to take one out or let a paused queue run. */
export function useWaitingQueue(client: EnvironmentClient, sessionId: string) {
  const last = useRef<WaitingQueue>(EMPTY_WAITING_QUEUE)
  const get = useCallback(() => {
    last.current = waitingQueueOf(threadOf(client, sessionId), last.current)
    return last.current
  }, [client, sessionId])
  const subscribe = useCallback((listener: () => void) => client.subscribe(listener), [client])
  const queue = useSyncExternalStore(subscribe, get, get)
  const target = useCallback(() => {
    const thread = threadOf(client, sessionId)
    if (!thread) throw new Error('The session is still opening.')
    return { sessionId, threadId: thread.thread.threadId }
  }, [client, sessionId])
  const remove = useCallback(
    async (queueItemId: string) =>
      client.commands.removeQueuedMessage({ ...target(), queueItemId }),
    [client, target],
  )
  const resume = useCallback(async () => client.commands.resumeQueue(target()), [client, target])
  const sendSteerNow = useCallback(
    async (queueItemId: string) => client.commands.sendSteerNow({ ...target(), queueItemId }),
    [client, target],
  )
  return { queue, remove, resume, sendSteerNow }
}

const ROW_IN = FadeIn.duration(180).easing(Easing.out(Easing.quad))
const ROW_OUT = FadeOut.duration(140).easing(Easing.in(Easing.quad))
const GROW = LinearTransition.duration(200).easing(Easing.out(Easing.cubic))
/** Three rows show; more scroll inside the card. */
const ROW_HEIGHT = 34
const MAX_ROWS = 3

/**
 * The messages waiting for the next turn, above the status line in the dock,
 * as web's list above the composer: in the order they will run, each on one
 * line with a remove, until it runs. A paused queue says why, with Resume.
 * Every row is the environment's: a remove asks it, and the row goes when
 * the queue it sends back no longer has it.
 */
export function QueuedMessagesRow({
  queue,
  onRemove,
  onResume,
}: {
  queue: WaitingQueue
  onRemove: (queueItemId: string) => Promise<void>
  onResume: () => Promise<void>
}) {
  const theme = usePhoneTheme()
  // Asked to go: the row keeps a spinner until the queue no longer has it.
  const [removing, setRemoving] = useState<ReadonlySet<string>>(new Set())
  const [resuming, setResuming] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  if (queue.items.length === 0 && !queue.pausedBy) return null

  const remove = (queueItemId: string) => {
    tap()
    setFailure(null)
    setRemoving((current) => new Set([...current, queueItemId]))
    onRemove(queueItemId).catch((error: unknown) => {
      setFailure(error instanceof Error && error.message ? error.message : 'Couldn’t remove it')
      setRemoving((current) => new Set([...current].filter((id) => id !== queueItemId)))
    })
  }
  const resume = () => {
    tap()
    setFailure(null)
    setResuming(true)
    onResume()
      .catch((error: unknown) =>
        setFailure(error instanceof Error && error.message ? error.message : 'Couldn’t resume'),
      )
      .finally(() => setResuming(false))
  }

  return (
    <Animated.View
      entering={ROW_IN}
      exiting={ROW_OUT}
      layout={GROW}
      accessibilityLabel={`${queue.items.length} queued ${queue.items.length === 1 ? 'message' : 'messages'}`}
      style={{ paddingHorizontal: 2 }}
    >
      <Glass strength="strong" shadow="rest" radius={16} contentStyle={{ paddingVertical: 3 }}>
        {queue.pausedBy ? (
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
              minHeight: 32,
              paddingLeft: 12,
              paddingRight: 6,
            }}
          >
            <AppText
              variant="text-12-regular"
              numberOfLines={1}
              style={{ color: theme.muted, flex: 1, minWidth: 0 }}
            >
              Paused: {QUEUE_PAUSE_REASON[queue.pausedBy]}
            </AppText>
            <Press
              accessibilityRole="button"
              accessibilityLabel="Resume the queue"
              accessibilityState={{ busy: resuming, disabled: resuming }}
              disabled={resuming}
              hitSlop={6}
              onPress={resume}
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                gap: 4,
                height: 26,
                paddingHorizontal: 10,
                borderRadius: 13,
                backgroundColor: pressed ? theme.active : theme.hover,
                opacity: resuming ? 0.6 : 1,
              })}
            >
              {resuming ? (
                <ActivityIndicator
                  size="small"
                  color={theme.fg}
                  style={{ transform: [{ scale: 0.6 }], width: 12, height: 12 }}
                />
              ) : null}
              <AppText variant="text-12-medium" style={{ color: theme.fg }}>
                Resume
              </AppText>
            </Press>
          </View>
        ) : null}
        <ScrollView
          style={{ maxHeight: ROW_HEIGHT * MAX_ROWS }}
          scrollEnabled={queue.items.length > MAX_ROWS}
          showsVerticalScrollIndicator={false}
        >
          {queue.items.map((item) => {
            const preview = queuedMessagePreview(item)
            const images = item.artifactIds?.length ?? 0
            const pending = removing.has(item.queueItemId)
            return (
              <Animated.View
                key={item.queueItemId}
                entering={ROW_IN}
                exiting={ROW_OUT}
                layout={GROW}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 8,
                  minHeight: ROW_HEIGHT,
                  paddingLeft: 12,
                  paddingRight: 6,
                }}
              >
                <ClockIcon size={12} color={theme.faint} weight="bold" />
                <AppText
                  variant="text-13-regular"
                  numberOfLines={1}
                  style={{ color: theme.fg, flex: 1, minWidth: 0 }}
                >
                  {preview}
                </AppText>
                {images > 0 && item.text.trim() ? (
                  <View
                    accessibilityLabel={images === 1 ? '1 image' : `${images} images`}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}
                  >
                    <ImageIcon size={12} color={theme.faint} />
                    <AppText variant="text-11-regular" style={{ color: theme.faint }}>
                      {images}
                    </AppText>
                  </View>
                ) : null}
                <Press
                  accessibilityRole="button"
                  accessibilityLabel={`Remove “${preview}”`}
                  accessibilityState={{ busy: pending, disabled: pending }}
                  disabled={pending}
                  hitSlop={6}
                  onPress={() => remove(item.queueItemId)}
                  style={({ pressed }) => ({
                    width: 26,
                    height: 26,
                    borderRadius: 13,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: pressed ? theme.active : 'transparent',
                  })}
                >
                  {pending ? (
                    <ActivityIndicator
                      size="small"
                      color={theme.muted}
                      style={{ transform: [{ scale: 0.7 }] }}
                    />
                  ) : (
                    <XIcon size={13} color={theme.muted} weight="bold" />
                  )}
                </Press>
              </Animated.View>
            )
          })}
        </ScrollView>
        {failure ? (
          <AppText
            variant="text-11-regular"
            accessibilityLiveRegion="polite"
            style={{ color: theme.status.error, paddingHorizontal: 12, paddingBottom: 4 }}
          >
            {failure}
          </AppText>
        ) : null}
      </Glass>
    </Animated.View>
  )
}
