import { memo } from 'react'
import { View } from 'react-native'
import type { AskedQuestion } from '@openmanager/app-core/logic'

import { usePhoneTheme } from '../../theme/ThemeProvider'
import { AppText } from '../ui/AppText'

/**
 * An answered question in the transcript (web's `AskedQuestionPart`): a
 * record of the exchange, not a message, so it sits on a quiet fill and lists
 * what was asked and what was answered.
 */
export const AskedQuestionPart = memo(function AskedQuestionPart({
  questions,
}: {
  questions: readonly AskedQuestion[]
}) {
  const theme = usePhoneTheme()
  return (
    <View
      style={{
        gap: 8,
        borderRadius: 12,
        backgroundColor: theme.hover,
        paddingHorizontal: 12,
        paddingVertical: 9,
      }}
    >
      {questions.map((question, index) => (
        <View key={`${question.prompt}:${index}`} style={{ gap: 2 }}>
          <AppText variant="text-13-regular" style={{ color: theme.muted }}>
            {question.prompt}
          </AppText>
          <AppText
            variant="text-14-medium"
            style={{ color: question.answer ? theme.fg : theme.faint }}
          >
            {question.answer ?? 'Skipped'}
          </AppText>
        </View>
      ))}
    </View>
  )
})
