import {
  ArrowClockwiseIcon,
  ArrowsInLineVerticalIcon,
  ArrowsLeftRightIcon,
  GaugeIcon,
  InfoIcon,
  ProhibitIcon,
  WarningCircleIcon,
  WarningIcon,
  type Icon,
} from 'phosphor-react-native'
import { memo, useRef, useState } from 'react'
import { View } from 'react-native'
import Animated from 'react-native-reanimated'
import {
  describeFailure,
  describeNotice,
  useTurnRecovery,
  type FailurePart,
  type NoticePart,
} from '@openmanager/app-core/logic'

import { usePhoneTheme } from '../../theme/ThemeProvider'
import { Press } from '../../ui/Press'
import { ShimmerText } from '../chat/ShimmerText'
import { AppText } from '../ui/AppText'
import { DisclosureChevron, revealBody } from './Disclosure'

type Notice = NoticePart['notice']

/** Web's glyph per notice kind (app-core `TurnNoticePart`). */
const NOTICE_ICONS: Record<Notice['kind'], Icon> = {
  retrying: ArrowClockwiseIcon,
  compacting: ArrowsInLineVerticalIcon,
  compacted: ArrowsInLineVerticalIcon,
  model_fallback: ArrowsLeftRightIcon,
  refusal: ProhibitIcon,
  usage_warning: GaugeIcon,
  info: InfoIcon,
  warning: WarningIcon,
}

/**
 * Something the provider said about the turn, on one quiet line laid out as
 * a tool row is: a retry under way, a compaction, a model switch, a limit
 * getting close. The wording is web's (`describeNotice`). A live notice
 * shimmers until the environment clears it; one with more to say (a
 * refusal's explanation) opens on a tap, and its words fade in.
 */
export const TurnNoticeRow = memo(function TurnNoticeRow({
  notice,
  live = false,
}: {
  notice: Notice
  live?: boolean
}) {
  const theme = usePhoneTheme()
  const copy = describeNotice(notice)
  const [open, setOpen] = useState(false)
  const revealedRef = useRef(false)
  const Glyph = NOTICE_ICONS[notice.kind] ?? InfoIcon
  const warning = copy.tone === 'warning'
  const said = copy.detail ? `${copy.label} · ${copy.detail}` : copy.label

  const line = (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8, minHeight: 20 }}>
      <View style={{ paddingTop: 3 }}>
        <Glyph size={13} color={warning ? theme.status.needs : theme.faint} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        {live ? (
          <ShimmerText variant="text-13-regular">{said}</ShimmerText>
        ) : (
          <AppText variant="text-13-regular" style={{ color: theme.muted }}>
            {copy.label}
            {copy.detail ? (
              <AppText variant="text-13-regular" style={{ color: theme.faint }}>
                {` · ${copy.detail}`}
              </AppText>
            ) : null}
          </AppText>
        )}
      </View>
      {copy.body ? (
        <View style={{ paddingTop: 4 }}>
          <DisclosureChevron open={open} color={theme.faint} size={10} />
        </View>
      ) : null}
    </View>
  )

  if (!copy.body) {
    return (
      <View
        accessibilityLabel={said}
        {...(live ? { accessibilityLiveRegion: 'polite' as const } : {})}
      >
        {line}
      </View>
    )
  }

  return (
    <View>
      <Press
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={said}
        hitSlop={4}
        onPress={() => {
          revealedRef.current = true
          setOpen((value) => !value)
        }}
        style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
      >
        {line}
      </Press>
      {open ? (
        <Animated.View
          entering={revealedRef.current ? revealBody : undefined}
          style={{ paddingLeft: 21, paddingTop: 6 }}
        >
          <View
            style={{
              borderRadius: 8,
              backgroundColor: theme.active,
              paddingHorizontal: 10,
              paddingVertical: 8,
            }}
          >
            <AppText variant="text-13-regular" selectable style={{ color: theme.muted }}>
              {copy.body}
            </AppText>
          </View>
        </Animated.View>
      ) : null}
    </View>
  )
})

/**
 * A failed turn: what happened, what to do about it, and the button that
 * does it when the phone can (Retry sends the turn's prompt again, Compact
 * asks for `/compact`). On a faint red fill, no outline. Only the newest
 * turn's failure offers its action; an older one, a background turn with no
 * prompt to send, or a host that cannot act keeps the guidance alone, so no
 * button is ever dead.
 */
export const TurnFailureRow = memo(function TurnFailureRow({ part }: { part: FailurePart }) {
  const theme = usePhoneTheme()
  const recovery = useTurnRecovery()
  const copy = describeFailure(
    part.failure,
    recovery?.providerName,
    undefined,
    part.resendable !== false,
  )
  const [pending, setPending] = useState(false)
  const perform =
    !part.actionable || !copy.action || !recovery
      ? undefined
      : copy.action.kind === 'retry'
        ? recovery.retry && (() => recovery.retry!(part.turnId))
        : recovery.compact
  const disabled = pending || !!recovery?.busy

  return (
    <View
      accessibilityLabel={[copy.title, copy.guidance].filter(Boolean).join('. ')}
      style={{
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 8,
        borderRadius: 10,
        backgroundColor: theme.statusWash.error,
        paddingHorizontal: 10,
        paddingVertical: 8,
      }}
    >
      <View style={{ paddingTop: 3 }}>
        <WarningCircleIcon size={14} color={theme.status.error} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <AppText variant="text-13-medium" style={{ color: theme.fg }}>
          {copy.title}
        </AppText>
        {copy.guidance ? (
          <AppText variant="text-13-regular" style={{ color: theme.muted }}>
            {copy.guidance}
          </AppText>
        ) : null}
        {copy.detail ? (
          // The provider's words: quieter than ours, but whole, since they
          // often say exactly what to change.
          <AppText
            variant="text-12-regular"
            selectable
            style={{ color: theme.faint, marginTop: 2 }}
          >
            {copy.detail}
          </AppText>
        ) : null}
      </View>
      {perform && copy.action ? (
        <Press
          accessibilityRole="button"
          accessibilityState={{ disabled }}
          disabled={disabled}
          hitSlop={8}
          onPress={() => {
            setPending(true)
            void perform().finally(() => setPending(false))
          }}
          style={({ pressed }) => ({
            borderRadius: 8,
            paddingHorizontal: 10,
            paddingVertical: 4,
            backgroundColor: pressed ? theme.active : theme.hover,
            opacity: disabled ? 0.5 : 1,
          })}
        >
          <AppText variant="text-12-medium" style={{ color: theme.fg }}>
            {copy.action.label}
          </AppText>
        </Press>
      ) : null}
    </View>
  )
})
