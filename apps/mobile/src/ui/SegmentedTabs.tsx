import { Pressable, View } from 'react-native'

import { AppText } from '../components/ui/AppText'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { tap } from './haptics'

export interface SegmentedTab<Key extends string> {
  key: Key
  label: string
  count?: number
}

/** Pills under a big title; the chosen one is a fill, not an underline. */
export function SegmentedTabs<Key extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: readonly SegmentedTab<Key>[]
  value: Key
  onChange: (key: Key) => void
}) {
  const theme = usePhoneTheme()
  return (
    <View className="flex-row gap-1.5 px-5 pb-2 pt-3.5">
      {tabs.map((tab) => {
        const on = tab.key === value
        return (
          <Pressable
            key={tab.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            onPress={() => {
              if (!on) tap()
              onChange(tab.key)
            }}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: 4,
              paddingHorizontal: 12,
              paddingVertical: 6,
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
          </Pressable>
        )
      })}
    </View>
  )
}
