import { ScrollView, useWindowDimensions, View } from 'react-native'

import { AppText } from '../components/ui/AppText'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { tap } from '../ui/haptics'
import { Press } from '../ui/Press'
import { Sheet } from '../ui/Sheet'
import type { ComposerModel, SessionConfigOption } from './model'

function ChoiceChip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  const theme = usePhoneTheme()
  return (
    <Press
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ checked: on }}
      onPress={() => {
        tap()
        onPress()
      }}
      style={({ pressed }) => ({
        paddingVertical: 7,
        paddingHorizontal: 12,
        borderRadius: 999,
        backgroundColor: on ? theme.active : pressed ? theme.hover : theme.hover,
      })}
    >
      <AppText variant="text-13-regular" style={{ color: on ? theme.fg : theme.muted }}>
        {label}
      </AppText>
    </Press>
  )
}

/** One setting: a choice of values, or on/off, as the provider lists it. */
function Setting({
  option,
  onChange,
}: {
  option: SessionConfigOption
  onChange: (value: string | boolean) => void
}) {
  const theme = usePhoneTheme()
  if (option.type === 'boolean') {
    const on = option.currentValue
    return (
      <Press
        accessibilityRole="switch"
        accessibilityLabel={option.name}
        accessibilityHint={option.description}
        accessibilityState={{ checked: on }}
        onPress={() => {
          tap()
          onChange(!on)
        }}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          paddingVertical: 10,
          paddingHorizontal: 12,
          borderRadius: 14,
          backgroundColor: pressed ? theme.hover : 'transparent',
        })}
      >
        <View style={{ flex: 1, minWidth: 0 }}>
          <AppText variant="text-14-regular" style={{ color: theme.fg }}>
            {option.name}
          </AppText>
          {option.description ? (
            <AppText variant="text-12-regular" style={{ color: theme.faint }}>
              {option.description}
            </AppText>
          ) : null}
        </View>
        <View
          style={{
            width: 38,
            height: 22,
            borderRadius: 11,
            padding: 3,
            alignItems: on ? 'flex-end' : 'flex-start',
            backgroundColor: on ? theme.actionBg : theme.active,
          }}
        >
          <View
            style={{
              width: 16,
              height: 16,
              borderRadius: 8,
              backgroundColor: on ? theme.actionFg : theme.muted,
            }}
          />
        </View>
      </Press>
    )
  }
  return (
    <View style={{ gap: 8, paddingVertical: 10, paddingHorizontal: 12 }}>
      <View>
        <AppText variant="text-14-regular" style={{ color: theme.fg }}>
          {option.name}
        </AppText>
        {option.description ? (
          <AppText variant="text-12-regular" style={{ color: theme.faint }}>
            {option.description}
          </AppText>
        ) : null}
      </View>
      <View
        accessibilityRole="radiogroup"
        style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}
      >
        {option.options.map((entry) => (
          <ChoiceChip
            key={entry.value}
            label={entry.name}
            on={entry.value === option.currentValue}
            onPress={() => onChange(entry.value)}
          />
        ))}
      </View>
    </View>
  )
}

/**
 * Session settings, behind the ⋯ menu: the provider's other settings (what
 * the model, mode and effort picks do not draw), each through the shared
 * composer logic, so the change is the environment's and shows on web.
 */
export function SettingsSheet({ model, onClose }: { model: ComposerModel; onClose: () => void }) {
  const theme = usePhoneTheme()
  const { height } = useWindowDimensions()
  return (
    <Sheet onDismiss={onClose} onBack={onClose}>
      <AppText
        accessibilityRole="header"
        variant="text-16-medium"
        style={{ color: theme.fg, textAlign: 'center', marginBottom: 6 }}
      >
        Session settings
      </AppText>
      {model.picks.lockedReason ? (
        <AppText
          variant="text-12-regular"
          style={{ color: theme.muted, textAlign: 'center', marginBottom: 6 }}
        >
          {model.picks.lockedReason}
        </AppText>
      ) : null}
      <ScrollView style={{ maxHeight: height * 0.55 }}>
        {model.settings.length === 0 ? (
          <AppText
            variant="text-14-regular"
            style={{ color: theme.muted, textAlign: 'center', padding: 12 }}
          >
            The provider lists no other settings for this session.
          </AppText>
        ) : (
          <View
            pointerEvents={model.picks.lockedReason ? 'none' : 'auto'}
            style={{ opacity: model.picks.lockedReason ? 0.45 : 1 }}
          >
            {model.settings.map((option) => (
              <Setting
                key={option.id}
                option={option}
                onChange={(value) => model.setSetting(option.id, value)}
              />
            ))}
          </View>
        )}
      </ScrollView>
    </Sheet>
  )
}
