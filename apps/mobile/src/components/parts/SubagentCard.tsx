import { CaretRightIcon, StopIcon } from 'phosphor-react-native'
import { createContext, memo, useContext, useEffect, useRef, useState } from 'react'
import { View } from 'react-native'
import Animated from 'react-native-reanimated'
import type { Subagent } from '@openmanager/protocol'
import {
  formatElapsed,
  providerName,
  subagentElapsedMs,
  subagentGroupSummary,
  subagentName,
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

/** The current time, each second while `active`: a running card's clock. */
function useTick(active: boolean): number {
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

/** A status worth saying in words: waiting, failed or stopped. Running and done say it with the glyph. */
function StatusFlag({ subagent }: { subagent: Subagent }) {
  const theme = usePhoneTheme()
  const tone = subagentTone(subagent.status)
  if (tone === 'running' || tone === 'done') return null
  const color =
    tone === 'failed'
      ? theme.status.error
      : tone === 'waiting'
        ? subagent.waitingOn === 'question'
          ? theme.status.question
          : theme.status.needs
        : theme.faint
  return (
    <AppText variant="text-12-regular" numberOfLines={1} style={{ color }}>
      {subagentStatusLabel(subagent)}
    </AppText>
  )
}

/**
 * One subagent the agent started, in place of the tool call that started it
 * (web's `SubagentCard`): how it stands, its name and kind, and how long it
 * has run. A tap opens its child session, where its work and answer are.
 */
export const SubagentCard = memo(function SubagentCard({ part }: { part: SubagentPart }) {
  const theme = usePhoneTheme()
  const subagent = part.subagent
  const now = useTick(isLive(subagent))
  const openChild = useContext(OpenChildSessionContext)
  const childId = subagent.childSessionId
  const open = childId && openChild ? () => openChild(childId) : undefined
  const name = subagentName(subagent)
  const elapsed = subagentElapsedMs(subagent, now)
  const stopped = subagentTone(subagent.status) === 'stopped'
  const kind = subagent.agentType && subagent.agentType !== name ? subagent.agentType : undefined
  return (
    <Press
      accessibilityRole={open ? 'button' : undefined}
      accessibilityLabel={`${open ? 'Open subagent' : 'Subagent'} ${name}, ${subagentStatusLabel(subagent)}`}
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
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        minHeight: 40,
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 12,
        backgroundColor: pressed && open ? theme.active : theme.hover,
      })}
      testID={`subagent:${subagent.subagentId}`}
    >
      <SubagentGlyph subagent={subagent} />
      <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
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
      <StatusFlag subagent={subagent} />
      {elapsed !== undefined ? (
        <AppText
          variant="text-12-regular"
          style={{ color: theme.faint, fontVariant: ['tabular-nums'] }}
        >
          {formatElapsed(elapsed)}
        </AppText>
      ) : null}
      {open ? <CaretRightIcon size={12} color={theme.faint} weight="bold" /> : null}
    </Press>
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
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.surface2,
    borderWidth: 2,
    borderColor: theme.hover,
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
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            minHeight: 42,
            paddingLeft: 8,
            paddingRight: 12,
            borderRadius: 12,
            backgroundColor: pressed ? theme.active : theme.hover,
          })}
        >
          <ProviderStack subagents={subagents} />
          <AppText variant="text-14-medium" style={{ color: theme.fg }}>
            {summary.title}
          </AppText>
          {waiting ? (
            <StatusMark mark={waiting.waitingOn === 'question' ? 'question' : 'needs'} size={12} />
          ) : running ? (
            <StatusMark mark="working" size={12} />
          ) : null}
          <AppText
            variant="text-12-regular"
            numberOfLines={1}
            style={{ color: theme.muted, flex: 1, minWidth: 0 }}
          >
            {summary.detail}
          </AppText>
          <DisclosureChevron open={open} color={theme.faint} />
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
