import { useRouter } from 'expo-router'
import type { BottomTabBarProps } from 'expo-router/js-tabs'
import { GearSixIcon, ListIcon, MagnifyingGlassIcon, TrayIcon } from 'phosphor-react-native'
import type { ComponentType } from 'react'
import { Pressable, View } from 'react-native'

import { AppText } from '../components/ui/AppText'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { Glass } from './Glass'
import { tap } from './haptics'

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

/**
 * The floating pill: Sessions · Inbox · Settings, with search detached
 * beside it, after Linear iOS. It is the tabs group's tab bar, so a tab
 * press goes through the navigator (one instance per tab, nothing pushed).
 * Glass over the content, which keeps scrolling under it. The badge is how
 * many sessions wait on you.
 */
export function PillNav({
  state,
  navigation,
  insets,
  badge = 0,
}: BottomTabBarProps & { badge?: number }) {
  const theme = usePhoneTheme()
  const router = useRouter()
  return (
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
      <Glass shadow="float" contentStyle={{ flexDirection: 'row', gap: 4, padding: 6 }}>
        {state.routes.map((route, index) => {
          const tab = TABS[route.name]
          if (!tab) return null
          const on = state.index === index
          const color = on ? theme.fg : theme.muted
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
                width: 48,
                height: 44,
                borderRadius: 999,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: on ? theme.active : 'transparent',
              }}
            >
              <tab.Icon size={21} color={color} />
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
  )
}
