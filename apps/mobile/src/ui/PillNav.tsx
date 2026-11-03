import { useRouter } from 'expo-router'
import type { BottomTabBarProps } from 'expo-router/js-tabs'
import { GearSixIcon, ListIcon, MagnifyingGlassIcon, TrayIcon } from 'phosphor-react-native'
import { useCallback, useEffect, useSyncExternalStore, type ComponentType } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  type SharedValue,
} from 'react-native-reanimated'

import { AppText } from '../components/ui/AppText'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { Glass, GlassTargetProvider } from './Glass'
import type { TabTargets } from './glass-target'
import { tap } from './haptics'
import { PILL_PADDING, pillOffset, TAB_GAP, TAB_HEIGHT, TAB_WIDTH, tabEmphasis } from './pill-nav'

/** The tabs group's routes, by file name, in pill order. */
const TABS: Record<
  string,
  { label: string; Icon: ComponentType<{ size: number; color: string }> }
> = {
  index: { label: 'Sessions', Icon: ListIcon },
  inbox: { label: 'Inbox', Icon: TrayIcon },
  settings: { label: 'Settings', Icon: GearSixIcon },
}

/** What a screen reader hears for a tab: the badge is part of the Inbox's name. */
function tabLabel(label: string, badge: number) {
  return badge > 0 ? `${label}, ${badge} ${badge === 1 ? 'needs' : 'need'} you` : label
}

/** The highlight's spring: quick, settles without a bounce. */
const SLIDE = { damping: 22, stiffness: 260, mass: 0.7 }

/**
 * A tab's icon: the muted one at rest, the strong one under the highlight,
 * crossing over as the highlight slides onto it, with a small lift.
 */
function TabIcon({
  Icon,
  index,
  position,
}: {
  Icon: ComponentType<{ size: number; color: string }>
  index: number
  position: SharedValue<number>
}) {
  const theme = usePhoneTheme()
  const onStyle = useAnimatedStyle(() => {
    const emphasis = tabEmphasis(position.value, index)
    return { opacity: emphasis, transform: [{ scale: 1 + 0.08 * emphasis }] }
  })
  const offStyle = useAnimatedStyle(() => ({
    opacity: 1 - tabEmphasis(position.value, index),
  }))
  return (
    <View style={{ width: 21, height: 21 }}>
      <Animated.View style={[StyleSheet.absoluteFill, offStyle]}>
        <Icon size={21} color={theme.muted} />
      </Animated.View>
      <Animated.View style={[StyleSheet.absoluteFill, onStyle]}>
        <Icon size={21} color={theme.fg} />
      </Animated.View>
    </View>
  )
}

/**
 * The floating pill: Sessions · Inbox · Settings, with search detached
 * beside it, after Linear iOS. It is the tabs group's tab bar, so a tab
 * press goes through the navigator (one instance per tab, nothing pushed).
 * One highlight slides between the tabs on a spring, and the icons cross
 * over as it reaches them, so a switch reads as one move with the screens'
 * own shift. Glass over the content, which keeps scrolling under it: the
 * pill is drawn beside the tabs' screens, so it blurs the target of the one
 * in front (`targets`), switching the moment the tab does, while the one it
 * leaves is still fading out. The badge is how many sessions wait on you.
 */
export function PillNav({
  state,
  navigation,
  insets,
  badge = 0,
  targets,
}: BottomTabBarProps & { badge?: number; targets: TabTargets }) {
  const theme = usePhoneTheme()
  const router = useRouter()
  const front = state.routes[state.index]?.name ?? ''
  const getTarget = useCallback(() => targets.get(front), [targets, front])
  const target = useSyncExternalStore(targets.subscribe, getTarget, getTarget)
  // Where the highlight is, in tabs: the index while at rest, between two mid-slide.
  const position = useSharedValue(state.index)
  useEffect(() => {
    position.value = withSpring(state.index, SLIDE)
  }, [position, state.index])
  const highlight = useAnimatedStyle(() => ({
    transform: [{ translateX: pillOffset(position.value) }],
  }))
  return (
    <GlassTargetProvider target={target}>
      <View
        pointerEvents="box-none"
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: Math.max(insets.bottom, 16) + 12,
          flexDirection: 'row',
          justifyContent: 'center',
          gap: 10,
          paddingHorizontal: 20,
        }}
      >
        <Glass
          shadow="float"
          contentStyle={{ flexDirection: 'row', gap: TAB_GAP, padding: PILL_PADDING }}
        >
          <Animated.View
            pointerEvents="none"
            style={[
              {
                position: 'absolute',
                top: PILL_PADDING,
                left: PILL_PADDING,
                width: TAB_WIDTH,
                height: TAB_HEIGHT,
                borderRadius: 999,
                backgroundColor: theme.active,
              },
              highlight,
            ]}
          />
          {state.routes.map((route, index) => {
            const tab = TABS[route.name]
            if (!tab) return null
            const on = state.index === index
            const count = route.name === 'inbox' ? badge : 0
            return (
              <Pressable
                key={route.key}
                accessibilityRole="tab"
                accessibilityLabel={tabLabel(tab.label, count)}
                accessibilityState={{ selected: on }}
                onPress={() => {
                  const event = navigation.emit({
                    type: 'tabPress',
                    target: route.key,
                    canPreventDefault: true,
                  })
                  if (on || event.defaultPrevented) return
                  tap()
                  navigation.navigate(route.name, route.params)
                }}
                onLongPress={() => navigation.emit({ type: 'tabLongPress', target: route.key })}
                style={{
                  width: TAB_WIDTH,
                  height: TAB_HEIGHT,
                  borderRadius: 999,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <TabIcon Icon={tab.Icon} index={index} position={position} />
                {count > 0 ? (
                  <View
                    style={{
                      position: 'absolute',
                      top: 7,
                      right: 7,
                      minWidth: 16,
                      height: 16,
                      paddingHorizontal: 4,
                      borderRadius: 8,
                      backgroundColor: theme.status.needs,
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderWidth: 2,
                      borderColor: theme.floatBg,
                    }}
                  >
                    <AppText
                      variant="text-10-medium"
                      style={{ color: theme.statusInk.needs, lineHeight: 12 }}
                    >
                      {count > 9 ? '9+' : count}
                    </AppText>
                  </View>
                ) : null}
              </Pressable>
            )
          })}
        </Glass>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Search"
          onPress={() => {
            tap()
            router.push('/search')
          }}
        >
          <Glass
            shadow="float"
            contentStyle={{ width: 56, height: 56, alignItems: 'center', justifyContent: 'center' }}
          >
            <MagnifyingGlassIcon size={22} color={theme.fg} />
          </Glass>
        </Pressable>
      </View>
    </GlassTargetProvider>
  )
}
