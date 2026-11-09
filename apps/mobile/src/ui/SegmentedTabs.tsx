import { View } from 'react-native'

import { AppText } from '../components/ui/AppText'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { tap } from './haptics'
import { Press } from './Press'

export interface SegmentedTab<Key extends string> {
  key: Key
  label: string
  count?: number
}

/**
 * Pills for the views of a screen; the chosen one is a fill, not an
 * underline. Under a big title by default (`className` places them
 * elsewhere: the home keeps them in its title row).
 */
export function SegmentedTabs<Key extends string>({
  tabs,
  value,
  onChange,
  className = 'flex-row gap-1.5 px-5 pb-2 pt-3.5',
}: {
  tabs: readonly SegmentedTab<Key>[]
  value: Key
  onChange: (key: Key) => void
  className?: string
}) {
  const theme = usePhoneTheme()
  return (
    <View className={className}>
      {tabs.map((tab) => {
        const on = tab.key === value
        return (
          <Press
            key={tab.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            // The pill is 34pt tall; the slop brings the target to 44.
            hitSlop={{ top: 5, bottom: 5 }}
            onPress={() => {
              if (!on) tap()
              onChange(tab.key)
            }}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: 4,
              paddingHorizontal: 12,
              paddingVertical: 7,
              borderRadius: 999,
              backgroundColor: on ? theme.active : pressed ? theme.hover : 'transparent',
            })}
          >
            <AppText variant="text-14-medium" style={{ color: on ? theme.fg : theme.muted }}>
              {tab.label}
            </AppText>
            {tab.count !== undefined ? (
              <AppText variant="text-14-regular" style={{ color: theme.faint }}>
                {tab.count}
              </AppText>
            ) : null}
          </Press>
        )
      })}
    </View>
  )
}
