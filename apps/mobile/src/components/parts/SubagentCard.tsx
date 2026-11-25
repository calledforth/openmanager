import { CaretRightIcon, StopIcon } from 'phosphor-react-native'
import { createContext, memo, useContext, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, View } from 'react-native'
import Animated from 'react-native-reanimated'
import type { Subagent } from '@openmanager/protocol'
import {
  formatElapsed,
  providerName,
  subagentElapsedMs,
  subagentGroupSummary,
  subagentModelLabel,
  subagentName,
  subagentDetail,
  subagentStatusLabel,
  subagentTone,
  type SubagentPart,
} from '@openmanager/app-core/logic'

import { usePhoneTheme } from '../../theme/ThemeProvider'
import { tap } from '../../ui/haptics'
import { Press } from '../../ui/Press'
import { ProviderMark } from '../../ui/ProviderMark'
import { StatusMark } from '../../ui/StatusMark'
import { AppText } from '../ui/AppText'
import { DisclosureChevron, revealBody } from './Disclosure'

/**
 * How the page opens a subagent's child session, by its id. Absent where
 * there is nowhere to go (a sample session), and then a card is not a button.
 */
export const OpenChildSessionContext = createContext<((childSessionId: string) => void) | null>(
  null,
)

/**
 * How the page stops a subagent (`subagent.stop`, through the shared
 * client). Absent where the environment cannot (or a sample session), and
 * then a live card offers no Stop.
 */
export const StopSubagentContext = createContext<((subagent: Subagent) => Promise<void>) | null>(
  null,
)

/** The current time, each second while `active`: a running card's clock. */
export function useTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

const isLive = (subagent: Pick<Subagent, 'status'>) => {
  const tone = subagentTone(subagent.status)
  return tone === 'running' || tone === 'waiting'
}

/** The glyph at the head of a card: the session list's marks, a square once stopped. */
function SubagentGlyph({ subagent }: { subagent: Pick<Subagent, 'status' | 'waitingOn'> }) {
  const theme = usePhoneTheme()
  switch (subagentTone(subagent.status)) {
    case 'running':
      return <StatusMark mark="working" size={14} />
    case 'waiting':
      return (
        <StatusMark mark={subagent.waitingOn === 'question' ? 'question' : 'needs'} size={14} />
      )
    case 'done':
      return <StatusMark mark="done" size={14} />
    case 'failed':
      return <StatusMark mark="error" size={14} />
    case 'stopped':
      return (
        <View style={{ width: 14, height: 14, alignItems: 'center', justifyContent: 'center' }}>
          <StopIcon size={10} color={theme.faint} weight="fill" />
        </View>
      )
  }
}

/**
 * The status in words, where nothing else on the card says it: a failed one
 * with no reason to give, on a soft wash of its colour, and a stopped one, in
 * faint words. Working and done say it with the glyph alone; a waiting one's
 * second line says what it waits on, and a failed one's why.
 */
function StatusFlag({ subagent, detail }: { subagent: Subagent; detail: string | undefined }) {
  const theme = usePhoneTheme()
  const tone = subagentTone(subagent.status)
  if (tone === 'stopped') {
    return (
      <AppText variant="text-12-regular" numberOfLines={1} style={{ color: theme.faint }}>
        {subagentStatusLabel(subagent)}
      </AppText>
    )
  }
  if (tone !== 'failed' || detail) return null
  const color = theme.status.error
  return (
    <View
      style={{
        height: 20,
        justifyContent: 'center',
        borderRadius: 6,
        paddingHorizontal: 6,
        backgroundColor: theme.wash(color),
      }}
    >
      <AppText variant="text-11-medium" numberOfLines={1} style={{ color }}>
        {subagentStatusLabel(subagent)}
      </AppText>
    </View>
  )
}

/** Agent types too generic to be worth a word. */
const PLAIN_TYPES = new Set(['general-purpose', 'general', 'default'])

/**
 * Stopping a subagent from its card: whether a stop is under way, and the
 * environment's reason when it refused one. Held by the card, so the pill,
 * the screen reader's action and the reason line say the same thing.
 */
function useStop(onStop: (() => Promise<void>) | undefined) {
  const [stopping, setStopping] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const run = () => {
    if (!onStop || stopping) return
    tap()
    setFailure(null)
    setStopping(true)
    onStop().catch((error: unknown) => {
      setFailure(error instanceof Error ? error.message : '')
      setStopping(false)
    })
  }
  return { stopping, failure, run }
}

/**
 * Stop, at the end of a live card the environment can stop: a small pill,
 * always there (a phone has no hover). It says "Stopping" until the card's
 * status moves, and "Try again" if the environment refused, with its reason
 * on a line under the card.
 */
function StopPill({
  name,
  stopping,
  failed,
  onPress,
}: {
  name: string
  stopping: boolean
  failed: boolean
  onPress: () => void
}) {
  const theme = usePhoneTheme()
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel={failed ? `Try again to stop ${name}` : `Stop ${name}`}
      accessibilityState={{ busy: stopping, disabled: stopping }}
      disabled={stopping}
      hitSlop={8}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        height: 26,
        paddingHorizontal: 9,
        borderRadius: 13,
        backgroundColor: pressed ? theme.active : theme.surface2,
      })}
      testID="subagent-stop"
    >
      {stopping ? (
        <ActivityIndicator
          size="small"
          color={theme.muted}
          style={{ transform: [{ scale: 0.55 }], width: 10, height: 10 }}
        />
      ) : (
        <StopIcon size={9} color={failed ? theme.status.error : theme.muted} weight="fill" />
      )}
      <AppText
        variant="text-12-regular"
        style={{ color: failed ? theme.status.error : theme.muted }}
      >
        {stopping ? 'Stopping' : failed ? 'Try again' : 'Stop'}
      </AppText>
    </Press>
  )
}

/**
 * One subagent the agent started, in place of the tool call that started it
 * (web's `SubagentCard`), a row like a tool row: its status as the glyph at
 * its head, its name and kind, what it runs on (its provider's mark), and how
 * long it has run. While it works, waits, or after it failed, a second line
 * says what it is doing, what it waits on, or why (`subagentDetail`); a
 * finished one stays one line. A tap opens its child session, where its work
 * and answer are; one with no session of its own (a Codex subagent's thread)
 * is not a button. A live one the environment can stop offers Stop at its end.
 */
export const SubagentCard = memo(function SubagentCard({ part }: { part: SubagentPart }) {
  const theme = usePhoneTheme()
  const subagent = part.subagent
  const live = isLive(subagent)
  const now = useTick(live)
  const openChild = useContext(OpenChildSessionContext)
  const stopSubagent = useContext(StopSubagentContext)
  const childId = subagent.childSessionId
  const open = childId && openChild ? () => openChild(childId) : undefined
  const stop = live && subagent.stoppable && stopSubagent ? () => stopSubagent(subagent) : undefined
  const name = subagentName(subagent)
  const elapsed = subagentElapsedMs(subagent, now)
  const stopped = subagentTone(subagent.status) === 'stopped'
  const tone = subagentTone(subagent.status)
  const kind =
    subagent.agentType && subagent.agentType !== name && !PLAIN_TYPES.has(subagent.agentType)
      ? subagent.agentType
      : undefined
  const detail = tone === 'done' || tone === 'stopped' ? undefined : subagentDetail(subagent)
  const detailColor =
    tone === 'failed'
      ? theme.status.error
      : tone === 'waiting'
        ? subagent.waitingOn === 'question'
          ? theme.status.question
          : theme.status.needs
        : theme.muted
  const model = subagentModelLabel(subagent.modelId) ?? providerName(subagent.providerId)
  const { stopping, failure, run } = useStop(stop)
  // The pill sits inside the card, where VoiceOver cannot reach it on its
  // own: the card carries Stop as an action of its own as well.
  const canStop = !!stop && !stopping
  // Stop sits beside the part that opens the card, not inside it: a button
  // in a button is no button on the web.
  const card = (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        borderRadius: 12,
        overflow: 'hidden',
        paddingRight: stop ? 7 : 0,
        backgroundColor: theme.hover,
      }}
    >
      <Press
        accessibilityRole={open ? 'button' : undefined}
        accessibilityLabel={[
          `${open ? 'Open subagent' : 'Subagent'} ${name}`,
          subagentStatusLabel(subagent),
          detail,
          model,
        ]
          .filter(Boolean)
          .join(', ')}
        accessibilityActions={canStop ? [{ name: 'stop', label: `Stop ${name}` }] : undefined}
        onAccessibilityAction={
          canStop
            ? (event) => {
                if (event.nativeEvent.actionName === 'stop') run()
              }
            : undefined
        }
        disabled={!open}
        onPress={
          open
            ? () => {
                tap()
                open()
              }
            : undefined
        }
        style={({ pressed }) => ({
          flex: 1,
          minWidth: 0,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          minHeight: 40,
          paddingLeft: 12,
          paddingRight: stop ? 10 : 12,
          paddingVertical: 7,
          backgroundColor: pressed && open ? theme.active : 'transparent',
        })}
        testID={`subagent:${subagent.subagentId}`}
      >
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <SubagentGlyph subagent={subagent} />
            <View
              style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'baseline', gap: 6 }}
            >
              <AppText
                variant="text-14-medium"
                numberOfLines={1}
                style={{ color: stopped ? theme.muted : theme.fg, flexShrink: 1 }}
              >
                {name}
              </AppText>
              {/* The name keeps its room; the kind gives way first. */}
              {kind ? (
                <AppText
                  variant="text-12-regular"
                  numberOfLines={1}
                  style={{ color: theme.faint, flexShrink: 20, minWidth: 0 }}
                >
                  {kind}
                </AppText>
              ) : null}
            </View>
            <StatusFlag subagent={subagent} detail={detail} />
            <ProviderMark providerId={subagent.providerId} size={12} />
            {elapsed !== undefined ? (
              <AppText
                variant="text-12-regular"
                style={{ color: theme.faint, fontVariant: ['tabular-nums'] }}
              >
                {formatElapsed(elapsed)}
              </AppText>
            ) : null}
          </View>
          {detail ? (
            <AppText
              variant="text-12-regular"
              numberOfLines={1}
              style={{ color: detailColor, paddingLeft: 24 }}
              testID="subagent-detail"
            >
              {detail}
            </AppText>
          ) : null}
        </View>
        {!stop && open ? <CaretRightIcon size={12} color={theme.faint} weight="bold" /> : null}
      </Press>
      {stop ? (
        <StopPill name={name} stopping={stopping} failed={failure !== null} onPress={run} />
      ) : null}
    </View>
  )
  if (!stop) return card
  // Why the environment refused, under the card: web says it in the Stop
  // button's tooltip, and a phone has no hover. The card keeps its place in
  // the same wrapper either way, so a refusal does not remount it.
  return (
    <View style={{ gap: 4 }}>
      {card}
      {failure !== null ? (
        <AppText
          variant="text-12-regular"
          numberOfLines={2}
          accessibilityLiveRegion="polite"
          style={{ color: theme.muted, paddingHorizontal: 12 }}
          testID="subagent-stop-failure"
        >
          {failure ? `Couldn’t stop it: ${failure}` : 'Couldn’t stop it'}
        </AppText>
      ) : null}
    </View>
  )
})

/** How many provider marks a folded group shows before the rest become "+N". */
const STACK_MAX = 4

/** What a folded group runs on: a mark per subagent, each tucked a little under the next. */
function ProviderStack({ subagents }: { subagents: readonly Subagent[] }) {
  const theme = usePhoneTheme()
  const shown = subagents.slice(0, STACK_MAX)
  const rest = subagents.length - shown.length
  const chip = {
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.surface2,
    borderWidth: 2,
    borderColor: theme.bg,
  } as const
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ flexDirection: 'row' }}
    >
      {shown.map((subagent, index) => (
        <View key={subagent.subagentId} style={[chip, index > 0 ? { marginLeft: -5 } : null]}>
          <ProviderMark providerId={subagent.providerId} size={11} />
        </View>
      ))}
      {rest > 0 ? (
        <View style={[chip, { marginLeft: -5 }]}>
          <AppText variant="text-11-medium" style={{ color: theme.muted }}>
            {`+${rest}`}
          </AppText>
        </View>
      ) : null}
    </View>
  )
}

/**
 * Subagents the agent started back to back (web's `SubagentGroup`). Folded,
 * one row: what they run on, how many, and how they stand. Unfolded, a card
 * each under it.
 */
export const SubagentGroup = memo(
  function SubagentGroup({ parts }: { parts: SubagentPart[] }) {
    const theme = usePhoneTheme()
    const [open, setOpen] = useState(false)
    const revealedRef = useRef(false)
    const subagents = parts.map((part) => part.subagent)
    const summary = subagentGroupSummary(subagents)
    const waiting = subagents.find((subagent) => subagent.status === 'waiting')
    const running = subagents.some((subagent) => subagentTone(subagent.status) === 'running')
    return (
      <View style={{ gap: 6 }}>
        <Press
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          accessibilityLabel={`${summary.title}, ${summary.detail}`}
          accessibilityHint={subagents
            .map((subagent) => providerName(subagent.providerId))
            .join(', ')}
          onPress={() => {
            revealedRef.current = true
            setOpen((value) => !value)
          }}
          // Flat on the page, as a work group's line is: no card around it.
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            alignSelf: 'flex-start',
            maxWidth: '100%',
            gap: 6,
            minHeight: 30,
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <ProviderStack subagents={subagents} />
          <AppText variant="text-14-regular" style={{ color: theme.muted }}>
            {summary.title}
          </AppText>
          {waiting ? (
            <StatusMark mark={waiting.waitingOn === 'question' ? 'question' : 'needs'} size={12} />
          ) : running ? (
            <StatusMark mark="working" size={12} />
          ) : null}
          <AppText variant="text-13-regular" style={{ color: theme.faint }}>
            ·
          </AppText>
          <AppText
            variant="text-13-regular"
            numberOfLines={1}
            style={{ color: theme.faint, flexShrink: 1, minWidth: 0 }}
          >
            {summary.detail}
          </AppText>
          <DisclosureChevron open={open} color={theme.faint} size={11} />
        </Press>
        {open ? (
          <Animated.View entering={revealedRef.current ? revealBody : undefined} style={{ gap: 6 }}>
            {parts.map((part) => (
              <SubagentCard key={part.id} part={part} />
            ))}
          </Animated.View>
        ) : null}
      </View>
    )
  },
  // The run is gathered anew on every event the turn gets; it is the same run
  // while it holds the same parts, so a streamed token leaves the header be.
  (previous, next) =>
    previous.parts.length === next.parts.length &&
    previous.parts.every((part, index) => part === next.parts[index]),
)
