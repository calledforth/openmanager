import { CheckIcon, DesktopIcon } from 'phosphor-react-native'
import { View } from 'react-native'

import { AppText } from '../components/ui/AppText'
import { Dot, toneColor } from '../settings/SettingsRow'
import type { PhoneConnectionTone } from '../environment/connection-ui'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { tap } from '../ui/haptics'
import { Press } from '../ui/Press'
import { Sheet } from '../ui/Sheet'

/** One saved environment, as the new-session page offers it. */
export interface EnvironmentChoice {
  environmentId: string
  label: string
  tone: PhoneConnectionTone
  /** Connected now, and not down: a draft can go there. */
  reachable: boolean
  /** Its state in a few words while it is not reachable. */
  words: string | null
}

/**
 * Where a new session runs: every saved environment, the page's own filled.
 * One that cannot be reached stays listed, saying why, and cannot be picked,
 * as web's picker keeps it. Picking another moves the page there: what is
 * written goes along as a new draft in that environment's last picked
 * project (`environment-move.ts`), its images stay where they were uploaded.
 */
export function EnvironmentSheet({
  environments,
  current,
  hasText,
  onPick,
  onClose,
}: {
  environments: readonly EnvironmentChoice[]
  current: string
  /** The page holds text that would be copied along. */
  hasText: boolean
  onPick: (environmentId: string) => void
  onClose: () => void
}) {
  const theme = usePhoneTheme()
  return (
    <Sheet onDismiss={onClose} onBack={onClose}>
      <View accessibilityRole="menu" style={{ paddingHorizontal: 6, paddingBottom: 2, gap: 2 }}>
        <View style={{ paddingHorizontal: 12, paddingBottom: 8, gap: 2 }}>
          <AppText accessibilityRole="header" variant="text-14-medium" style={{ color: theme.fg }}>
            Run it on
          </AppText>
          <AppText variant="text-12-regular" style={{ color: theme.muted }}>
            {hasText
              ? 'What you wrote moves along, into the project you last used there.'
              : 'Opens in the project you last used there.'}
          </AppText>
        </View>
        {environments.map((environment) => {
          const on = environment.environmentId === current
          const usable = on || environment.reachable
          const detail = usable ? null : (environment.words ?? 'Not connected')
          return (
            <Press
              key={environment.environmentId}
              accessibilityRole="menuitem"
              accessibilityLabel={environment.label}
              accessibilityHint={detail ?? undefined}
              accessibilityState={{ selected: on, disabled: !usable }}
              disabled={!usable}
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
                borderRadius: 14,
                backgroundColor: on ? theme.active : pressed ? theme.hover : 'transparent',
              })}
            >
              <View
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 10,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: on ? theme.hover : theme.active,
                  opacity: usable ? 1 : 0.5,
                }}
              >
                <DesktopIcon size={16} color={theme.fg} />
                <View style={{ position: 'absolute', right: -1, bottom: -1 }}>
                  <Dot color={toneColor(theme, environment.tone)} size={8} />
                </View>
              </View>
              <View style={{ flex: 1, minWidth: 0, opacity: usable ? 1 : 0.5 }}>
                <AppText variant="text-14-medium" numberOfLines={1} style={{ color: theme.fg }}>
                  {environment.label}
                </AppText>
                {detail ? (
                  <AppText
                    variant="text-12-regular"
                    numberOfLines={1}
                    style={{ color: theme.muted }}
                  >
                    {detail}
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
