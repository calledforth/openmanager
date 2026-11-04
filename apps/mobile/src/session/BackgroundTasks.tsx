import {
  BinocularsIcon,
  CaretDownIcon,
  CircleDashedIcon,
  FlowArrowIcon,
  RobotIcon,
  SquareIcon,
  TerminalWindowIcon,
  type IconProps,
} from 'phosphor-react-native'
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
} from 'react'
import { ActivityIndicator, View } from 'react-native'
import Animated, { Easing, FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated'
import type { BackgroundTask, EnvironmentClient } from '@openmanager/environment-client'

import { AppText } from '../components/ui/AppText'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { Glass } from '../ui/Glass'
import { tap } from '../ui/haptics'
import { Press } from '../ui/Press'

import { backgroundSummary, taskLabel } from './background-tasks'

const KIND: Record<BackgroundTask['kind'], { Icon: ComponentType<IconProps> }> = {
  agent: { Icon: RobotIcon },
  shell: { Icon: TerminalWindowIcon },
  monitor: { Icon: BinocularsIcon },
  workflow: { Icon: FlowArrowIcon },
  other: { Icon: CircleDashedIcon },
}

const NO_TASKS: readonly BackgroundTask[] = []

/** A key that changes only when the tasks the environment lists change. */
const tasksKey = (tasks: readonly BackgroundTask[]) =>
  tasks.map((task) => `${task.taskId}\u0000${task.kind}\u0000${task.description}`).join('\n')

/**
 * The background tasks the environment lists for a session, as the same
 * array while they are the same tasks, so a streamed token that changes the
 * state but not the tasks re-renders nothing here.
 */
export function useBackgroundTasks(
  client: Pick<EnvironmentClient, 'getState' | 'subscribe'>,
  sessionId: string,
): readonly BackgroundTask[] {
  const last = useRef<{ key: string; tasks: readonly BackgroundTask[] }>({ key: '', tasks: NO_TASKS })
  const get = useCallback(() => {
    const tasks = client.getState().sessions[sessionId]?.backgroundTasks ?? NO_TASKS
    const key = tasksKey(tasks)
    if (key !== last.current.key) last.current = { key, tasks }
    return last.current.tasks
  }, [client, sessionId])
  const subscribe = useCallback((listener: () => void) => client.subscribe(listener), [client])
  return useSyncExternalStore(subscribe, get, get)
}

const ROW_IN = FadeIn.duration(180).easing(Easing.out(Easing.quad))
const ROW_OUT = FadeOut.duration(140).easing(Easing.in(Easing.quad))
const GROW = LinearTransition.duration(200).easing(Easing.out(Easing.cubic))

function StopButton({
  label,
  pending,
  onPress,
}: {
  label: string
  pending: boolean
  onPress: () => void
}) {
  const theme = usePhoneTheme()
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel={pending ? 'Stopping…' : label}
      accessibilityState={{ busy: pending, disabled: pending }}
      disabled={pending}
      hitSlop={6}
      onPress={() => {
        tap()
        onPress()
      }}
      style={({ pressed }) => ({
        width: 26,
        height: 26,
        borderRadius: 13,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: pressed ? theme.active : 'transparent',
        opacity: pending ? 0.7 : 1,
      })}
    >
      {pending ? (
        <ActivityIndicator size="small" color={theme.muted} style={{ transform: [{ scale: 0.7 }] }} />
      ) : (
        <SquareIcon size={10} color={theme.muted} weight="fill" />
      )}
    </Press>
  )
}

/**
 * Work the agent left running after its turn, above the status line in the
 * dock, as web's pill above the composer: a backgrounded command, a
 * subagent, a watch loop. Between turns this is the only sign the session
 * is still busy, and its Stop the only way to end that work. One task reads
 * as its words; several fold to a count that opens the list, where each can
 * be stopped alone. Without `onStop` (an environment that cannot stop them)
 * the row only tells.
 */
export function BackgroundTasksRow({
  tasks,
  onStop,
}: {
  tasks: readonly BackgroundTask[]
  /** Stop the tasks named, or all of them. Rejects when the environment refuses. */
  onStop?: (taskIds?: string[]) => Promise<void>
}) {
  const theme = usePhoneTheme()
  const [open, setOpen] = useState(false)
  // "Stopping…" holds until the task leaves the list: the command settling
  // means only that the provider was asked.
  const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set())
  const [failed, setFailed] = useState(false)
  const several = tasks.length > 1
  useEffect(() => {
    if (!several) setOpen(false)
  }, [several])
  if (tasks.length === 0) return null

  const stop = (taskIds?: string[]) => {
    if (!onStop) return
    const asked = taskIds ?? tasks.map((task) => task.taskId)
    setFailed(false)
    setStopping((current) => new Set([...current, ...asked]))
    onStop(taskIds).catch(() => {
      setFailed(true)
      setStopping((current) => new Set([...current].filter((id) => !asked.includes(id))))
    })
  }
  const isStopping = (task: BackgroundTask) => stopping.has(task.taskId)
  const only = tasks[0]!
  const OnlyIcon = KIND[only.kind].Icon
  const summary = backgroundSummary(tasks)

  return (
    <Animated.View
      entering={ROW_IN}
      exiting={ROW_OUT}
      layout={GROW}
      accessibilityRole="summary"
      accessibilityLabel={several ? summary : `Running in the background: ${summary}`}
      style={{ alignSelf: 'flex-start', maxWidth: '100%', paddingHorizontal: 2 }}
    >
      <Glass strength="strong" shadow="rest" radius={16} contentStyle={{ paddingVertical: 2 }}>
        {several && open ? (
          <View style={{ paddingTop: 4, paddingBottom: 2 }}>
            {tasks.map((task) => {
              const Icon = KIND[task.kind].Icon
              return (
                <View
                  key={task.taskId}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 8,
                    paddingLeft: 12,
                    paddingRight: 6,
                    minHeight: 30,
                  }}
                >
                  <Icon size={12} color={theme.faint} weight="bold" />
                  <AppText
                    variant="text-12-regular"
                    numberOfLines={1}
                    style={{ color: theme.fg, flex: 1, minWidth: 0 }}
                  >
                    {taskLabel(task)}
                  </AppText>
                  {onStop ? (
                    <StopButton
                      label={`Stop ${taskLabel(task)}`}
                      pending={isStopping(task)}
                      onPress={() => stop([task.taskId])}
                    />
                  ) : null}
                </View>
              )
            })}
          </View>
        ) : null}
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            minHeight: 32,
            paddingLeft: 12,
            paddingRight: onStop ? 6 : 12,
          }}
        >
          <View
            style={{
              width: 7,
              height: 7,
              borderRadius: 4,
              backgroundColor: theme.status.background,
            }}
          />
          {several ? (
            <Press
              accessibilityRole="button"
              accessibilityState={{ expanded: open }}
              onPress={() => {
                tap()
                setOpen((current) => !current)
              }}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 1 }}
            >
              <AppText variant="text-12-medium" numberOfLines={1} style={{ color: theme.fg }}>
                {summary}
              </AppText>
              <CaretDownIcon
                size={11}
                color={theme.faint}
                weight="bold"
                style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }}
              />
            </Press>
          ) : (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 }}>
              <OnlyIcon size={12} color={theme.faint} weight="bold" />
              <AppText
                variant="text-12-medium"
                numberOfLines={1}
                style={{ color: theme.fg, flexShrink: 1 }}
              >
                {summary}
              </AppText>
            </View>
          )}
          {failed ? (
            <AppText variant="text-11-regular" style={{ color: theme.status.error }}>
              Couldn’t stop
            </AppText>
          ) : null}
          {onStop ? (
            <StopButton
              label={several ? 'Stop all' : 'Stop'}
              pending={tasks.every(isStopping)}
              onPress={() => stop()}
            />
          ) : null}
        </View>
      </Glass>
    </Animated.View>
  )
}
