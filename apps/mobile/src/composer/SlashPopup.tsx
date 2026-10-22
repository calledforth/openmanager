import { ScrollView, View } from 'react-native'
import Animated, { Easing, FadeIn, FadeOut } from 'react-native-reanimated'
import { type SlashCommandItem } from '@openmanager/app-core/logic'

import { AppText } from '../components/ui/AppText'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { Glass } from '../ui/Glass'
import { tap } from '../ui/haptics'
import { Press } from '../ui/Press'

const POPUP_IN = FadeIn.duration(160).easing(Easing.out(Easing.quad))
const POPUP_OUT = FadeOut.duration(120).easing(Easing.in(Easing.quad))

/**
 * The session's commands matching what is typed after `/`, above the field.
 * Picking one puts `/name ` in the field (the shared `applySlashCommand`);
 * providers run commands as prompt text, so nothing else is sent.
 */
export function SlashPopup({
  commands,
  onPick,
}: {
  commands: readonly SlashCommandItem[]
  onPick: (command: SlashCommandItem) => void
}) {
  const theme = usePhoneTheme()
  return (
    <Animated.View
      entering={POPUP_IN}
      exiting={POPUP_OUT}
      style={{ marginHorizontal: 12, marginBottom: 6 }}
    >
      <Glass strength="sheet" shadow="float" radius={14} contentStyle={{ padding: 6 }}>
        <ScrollView style={{ maxHeight: 240 }} keyboardShouldPersistTaps="always">
          <View accessibilityRole="menu">
            {commands.map((command) => (
              <Press
                key={command.name}
                accessibilityRole="menuitem"
                accessibilityLabel={`/${command.name}`}
                accessibilityHint={command.description || undefined}
                onPress={() => {
                  tap()
                  onPick(command)
                }}
                style={({ pressed }) => ({
                  paddingVertical: 8,
                  paddingHorizontal: 10,
                  borderRadius: 10,
                  backgroundColor: pressed ? theme.hover : 'transparent',
                })}
              >
                <AppText variant="mono" numberOfLines={1} style={{ color: theme.fg, fontSize: 13 }}>
                  {`/${command.name}`}
                </AppText>
                {command.description ? (
                  <AppText
                    variant="text-12-regular"
                    numberOfLines={2}
                    style={{ color: theme.muted }}
                  >
                    {command.description}
                  </AppText>
                ) : null}
              </Press>
            ))}
          </View>
        </ScrollView>
      </Glass>
    </Animated.View>
  )
}
