import { ClockIcon } from 'phosphor-react-native'
import { View } from 'react-native'

import { useTokens } from '../../theme/useTokens'
import { AppText } from '../ui/AppText'

// Right-aligned user bubble: surfaceElevated bg, radius 6, chat-user type.
// Optimistic (not yet acked by the backend) messages render dimmed with a
// clock glyph — the plan's "queued" state, which also covers jobs parked as
// `pending` while the desktop worker is offline.

export function UserMessage({ content, isQueued }: { content: string; isQueued?: boolean }) {
  const tokens = useTokens()

  return (
    <View className="w-full flex-row justify-end py-1">
      <View
        className="max-w-[85%] rounded border border-borderMuted bg-surfaceElevated px-3 py-2"
        style={isQueued ? { opacity: 0.6 } : undefined}
      >
        <AppText variant="chat-user" selectable>
          {content}
        </AppText>
        {isQueued ? (
          <View className="mt-1 flex-row items-center justify-end gap-1">
            <ClockIcon size={11} color={tokens.textFaint} />
            <AppText variant="text-11-regular" className="text-textFaint">
              queued
            </AppText>
          </View>
        ) : null}
      </View>
    </View>
  )
}
