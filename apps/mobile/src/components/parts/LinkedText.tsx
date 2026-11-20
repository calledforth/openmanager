import { useMemo, type ReactNode } from 'react'
import { Linking, Text } from 'react-native'
import { withAlpha } from '@openmanager/app-core/lib/theme-tokens'

import { usePhoneTheme } from '../../theme/ThemeProvider'
import { linkRuns } from './link-text'
import { LINKIFY } from './TextPart'

/**
 * Plain text (a prompt as typed) with its links tappable, as web draws them.
 * Goes inside a selectable `Text`, so selecting still runs across the links.
 */
export function LinkedText({ text }: { text: string }): ReactNode {
  const theme = usePhoneTheme()
  const runs = useMemo(() => linkRuns(text, LINKIFY), [text])
  return runs.map((run, at) =>
    run.url ? (
      <Text
        key={at}
        accessibilityRole="link"
        style={{
          textDecorationLine: 'underline',
          textDecorationColor: withAlpha(theme.fg, 0.35),
        }}
        onPress={() => {
          Linking.openURL(run.url!).catch(() => {})
        }}
      >
        {run.text}
      </Text>
    ) : (
      run.text
    ),
  )
}
