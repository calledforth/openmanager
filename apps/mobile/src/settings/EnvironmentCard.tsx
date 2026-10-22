import { CaretRightIcon, GlobeIcon, WifiHighIcon } from 'phosphor-react-native'
import { Pressable, View } from 'react-native'
import Animated, { FadeIn } from 'react-native-reanimated'

import { AppText } from '../components/ui/AppText'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { shortAge } from '../ui/SessionRow'
import { tap } from '../ui/haptics'
import type { EnvironmentCardView } from './environments'
import { Dot, Pill, toneColor } from './SettingsRow'

const WORDS_IN = FadeIn.duration(180)

/**
 * One saved environment on Settings: its name and state dot, "here" on the
 * one the phone connects to (also the stronger fill), and under it the route
 * in use, or what stands in the way, in the shared words. Opens the
 * environment's page.
 */
export function EnvironmentCard({
  card,
  onPress,
}: {
  card: EnvironmentCardView
  onPress: () => void
}) {
  const theme = usePhoneTheme()
  const RouteIcon = card.route?.kind === 'lan' ? WifiHighIcon : GlobeIcon
  const meta = card.route ? `${card.route.host}` : card.words
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${card.label}${card.selected ? ', in use' : ''}${meta ? `, ${meta}` : ''}`}
      onPress={() => {
        tap()
        onPress()
      }}
      style={({ pressed }) => ({
        marginHorizontal: 4,
        marginTop: 4,
        borderRadius: 18,
        paddingHorizontal: 14,
        paddingTop: 14,
        paddingBottom: 12,
        gap: 8,
        backgroundColor: card.selected || pressed ? theme.active : theme.hover,
      })}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <Dot color={toneColor(theme, card.tone)} />
        <AppText
          variant="text-16-medium"
          numberOfLines={1}
          style={{ color: theme.fg, flex: 1, letterSpacing: -0.1 }}
        >
          {card.label}
        </AppText>
        {card.selected ? <Pill tone="strong">here</Pill> : null}
        <CaretRightIcon size={14} color={theme.faint} />
      </View>
      <Animated.View
        key={meta ?? ''}
        entering={WORDS_IN}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}
      >
        {card.route ? (
          <>
            <RouteIcon size={13} color={theme.muted} />
            <AppText variant="mono" numberOfLines={1} style={{ color: theme.muted, fontSize: 12 }}>
              {card.route.host}
            </AppText>
          </>
        ) : (
          <AppText
            variant="text-12-regular"
            numberOfLines={1}
            style={{ color: theme.muted, flexShrink: 1 }}
          >
            {card.words}
            {card.since ? ` · ${sinceWords(card.since)}` : ''}
          </AppText>
        )}
      </Animated.View>
    </Pressable>
  )
}

/** "3d ago", "just now". */
export function sinceWords(iso: string): string {
  const age = shortAge(iso)
  if (!age) return ''
  return age === 'now' ? 'just now' : `${age} ago`
}
