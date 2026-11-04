import { memo, useEffect, useState } from 'react'
import { View } from 'react-native'
import Animated, { Easing, FadeIn } from 'react-native-reanimated'

import { AppText } from '../components/ui/AppText'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { StatusMark } from '../ui/StatusMark'
import { countRender } from './render-probe'
import { clockTickMs, formatClock, type StatusClock, type StatusLineView } from './status-line'

/** A changed state fades in; short, eased, on the UI thread. */
const STATE_IN = FadeIn.duration(200).easing(Easing.out(Easing.quad))

/** The clock's text, ticking on its own so nothing else re-renders with it. */
function Clock({ clock, color }: { clock: StatusClock; color: string }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), clockTickMs(clock))
    return () => clearInterval(timer)
  }, [clock])
  return (
    <AppText variant="text-12-regular" style={{ color, fontVariant: ['tabular-nums'] }}>
      {formatClock(clock, now)}
    </AppText>
  )
}

/**
 * What the session is doing, above the dock: its mark, the listed status in
 * words (in its status colour when it waits on the reader or failed), why it
 * failed when the environment says, and the time on the right. A new state
 * fades in; the clock ticks without re-rendering the line.
 */
export const StatusLine = memo(function StatusLine({ view }: { view: StatusLineView | null }) {
  countRender('StatusLine')
  const theme = usePhoneTheme()
  if (!view) return null
  // The state's own colour, as the web sidebar paints its status words.
  const toned = theme.status[view.mark]
  return (
    <Animated.View
      // Keyed by the state, so only a change of state fades; the clock and
      // the detail update in place.
      key={view.mark}
      entering={STATE_IN}
      accessibilityRole="text"
      style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 10 }}
    >
      <StatusMark mark={view.mark} size={11} />
      <AppText variant="text-12-medium" style={{ color: toned }}>
        {view.label}
      </AppText>
      <View style={{ flex: 1, minWidth: 0 }}>
        {view.detail ? (
          <AppText variant="text-12-regular" numberOfLines={1} style={{ color: theme.muted }}>
            {view.detail}
          </AppText>
        ) : null}
      </View>
      {view.clock ? <Clock clock={view.clock} color={theme.faint} /> : null}
    </Animated.View>
  )
})
