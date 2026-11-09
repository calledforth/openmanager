import { CheckIcon } from 'phosphor-react-native'
import { View } from 'react-native'

import { AppText } from '../components/ui/AppText'
import type { HomeEnvironmentState } from '../home/source'
import { Dot, toneColor } from '../settings/SettingsRow'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { tap } from '../ui/haptics'
import { Press } from '../ui/Press'
import { Sheet } from '../ui/Sheet'

/**
 * Where a new session runs: every saved environment, each with its own
 * state, the page's own checked. Picking another opens that environment's
 * new-session page in place, with the project last picked there. Offered
 * only while the page holds nothing, so nothing written is left behind or
 * copied (`environmentChoice` in `DraftPage`).
 */
export function EnvironmentSheet({
  environments,
  current,
  onPick,
  onClose,
}: {
  environments: readonly HomeEnvironmentState[]
  current: string
  onPick: (environmentId: string) => void
  onClose: () => void
}) {
  const theme = usePhoneTheme()
  return (
    <Sheet onDismiss={onClose} onBack={onClose}>
      <View accessibilityRole="menu" style={{ paddingHorizontal: 6, paddingBottom: 2, gap: 2 }}>
        <AppText
          accessibilityRole="header"
          variant="text-13-medium"
          style={{ color: theme.muted, paddingHorizontal: 12, paddingBottom: 6 }}
        >
          Run it on
        </AppText>
        {environments.map((environment) => {
          const on = environment.environmentId === current
          return (
            <Press
              key={environment.environmentId}
              accessibilityRole="menuitem"
              accessibilityLabel={environment.label}
              accessibilityHint={environment.words ?? undefined}
              accessibilityState={{ selected: on }}
              onPress={() => {
                tap()
                if (on) onClose()
                else onPick(environment.environmentId)
              }}
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                gap: 12,
                minHeight: 52,
                paddingHorizontal: 12,
                borderRadius: 12,
                backgroundColor: on || pressed ? theme.active : 'transparent',
              })}
            >
              <Dot color={toneColor(theme, environment.tone)} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <AppText variant="text-14-medium" numberOfLines={1} style={{ color: theme.fg }}>
                  {environment.label}
                </AppText>
                {environment.words ? (
                  <AppText
                    variant="text-12-regular"
                    numberOfLines={1}
                    style={{ color: theme.muted }}
                  >
                    {environment.words}
                  </AppText>
                ) : null}
              </View>
              {on ? <CheckIcon size={16} color={theme.fg} weight="bold" /> : null}
            </Press>
          )
        })}
      </View>
    </Sheet>
  )
}
