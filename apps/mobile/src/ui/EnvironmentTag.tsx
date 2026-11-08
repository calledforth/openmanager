import { HardDrivesIcon } from 'phosphor-react-native'
import { View } from 'react-native'

import { AppText } from '../components/ui/AppText'
import type { HomeEnvironmentRef } from '../home/rows'
import { usePhoneTheme } from '../theme/ThemeProvider'

/**
 * Where a row runs, at the end of its second line, as web's sidebar names
 * the environment on a card (`EnvironmentLabel`): faint, the drives icon
 * and the name. Shown only where the rows span more than one environment;
 * with one, it is context, not news. Last on the line and the first to
 * give way, so the project and the status keep their room.
 */
export function EnvironmentTag({ environment }: { environment: HomeEnvironmentRef }) {
  const theme = usePhoneTheme()
  return (
    <View
      accessibilityLabel={`On ${environment.label}`}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        flexShrink: 3,
        minWidth: 0,
      }}
    >
      <HardDrivesIcon size={11} color={theme.faint} />
      <AppText
        variant="text-12-regular"
        numberOfLines={1}
        style={{ color: theme.faint, flexShrink: 1 }}
      >
        {environment.label}
      </AppText>
    </View>
  )
}

/** The dot between two items of a row's second line. */
export function LineDot() {
  const theme = usePhoneTheme()
  return (
    <AppText variant="text-12-regular" style={{ color: theme.faint }}>
      ·
    </AppText>
  )
}
