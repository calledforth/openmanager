import { usePathname, useRouter } from 'expo-router'
import { GearSixIcon, ListIcon, MagnifyingGlassIcon, TrayIcon } from 'phosphor-react-native'
import { Pressable, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { AppText } from '../components/ui/AppText'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { Glass } from './Glass'
import { tap } from './haptics'

type TabKey = 'sessions' | 'inbox' | 'settings'

const TABS: { key: TabKey; path: '/' | '/inbox' | '/settings'; label: string }[] = [
  { key: 'sessions', path: '/', label: 'Sessions' },
  { key: 'inbox', path: '/inbox', label: 'Inbox' },
  { key: 'settings', path: '/settings', label: 'Settings' },
]

export function activeTab(pathname: string): TabKey | null {
  if (pathname === '/' || pathname === '') return 'sessions'
  if (pathname.startsWith('/inbox')) return 'inbox'
  if (pathname.startsWith('/settings')) return 'settings'
  return null
}

/**
 * The floating pill: Sessions · Inbox · Settings, with search detached
 * beside it, after Linear iOS. Glass over the content, which keeps scrolling
 * under it. The badge is how many sessions wait on you.
 */
export function PillNav({ badge = 0 }: { badge?: number }) {
  const theme = usePhoneTheme()
  const router = useRouter()
  const pathname = usePathname()
  const insets = useSafeAreaInsets()
  const current = activeTab(pathname)
  if (!current) return null
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
        {TABS.map((tab) => {
          const on = tab.key === current
          const color = on ? theme.fg : theme.muted
          return (
            <Pressable
              key={tab.key}
              accessibilityRole="tab"
              accessibilityLabel={tab.label}
              accessibilityState={{ selected: on }}
              onPress={() => {
                if (on) return
                tap()
                router.navigate(tab.path)
              }}
              style={{
                width: 48,
                height: 44,
                borderRadius: 999,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: on ? theme.active : 'transparent',
              }}
            >
              {tab.key === 'sessions' ? (
                <ListIcon size={21} color={color} />
              ) : tab.key === 'inbox' ? (
                <TrayIcon size={21} color={color} />
              ) : (
                <GearSixIcon size={21} color={color} />
              )}
              {tab.key === 'inbox' && badge > 0 ? (
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
                  <AppText variant="text-10-medium" style={{ color: '#1a1a1a', lineHeight: 12 }}>
                    {badge > 9 ? '9+' : badge}
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
