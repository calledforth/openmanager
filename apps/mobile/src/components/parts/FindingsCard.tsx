import { ListChecksIcon } from 'phosphor-react-native'
import { memo } from 'react'
import { View } from 'react-native'

import { usePhoneTheme } from '../../theme/ThemeProvider'
import { AppText } from '../ui/AppText'
import { TextPart } from './TextPart'

/**
 * What a code review found (`/review`): the review turn's answer on a card
 * of its own under the review's "finished" marker, so it reads as the
 * review's result rather than as the agent talking (web's `FindingsCard`).
 * A fill, no outline; the header sits on a slightly deeper band.
 */
export const FindingsCard = memo(function FindingsCard({
  text,
  live = false,
}: {
  text: string
  live?: boolean
}) {
  const theme = usePhoneTheme()
  if (!text) return null
  return (
    <View
      accessibilityLabel="Review findings"
      style={{ borderRadius: 12, overflow: 'hidden', backgroundColor: theme.hover }}
      testID="review-findings"
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          paddingHorizontal: 12,
          paddingVertical: 7,
          backgroundColor: theme.active,
        }}
      >
        <ListChecksIcon size={13} color={theme.muted} />
        <AppText variant="text-12-medium" style={{ color: theme.muted }}>
          Findings
        </AppText>
      </View>
      <View style={{ paddingHorizontal: 14, paddingVertical: 10 }}>
        <TextPart text={text} live={live} />
      </View>
    </View>
  )
})
