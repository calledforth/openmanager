import { ArrowUpIcon, SquareIcon } from 'phosphor-react-native'
import { useState } from 'react'
import { TextInput, TouchableOpacity, View } from 'react-native'

import { useTokens } from '../../theme/useTokens'
import { AppText } from '../ui/AppText'

// Bottom-pinned composer (plan Phase 4): surface input with 1px border and
// radius 6, monochrome actionBg/actionFg send button. While the session is
// active a destructive-outline Stop button (abort) joins the row. When the
// session has no desktop client (`!isReachable`) the whole composer is
// disabled behind an inline notice.

export function Composer({
  isReachable,
  isSessionActive,
  onSend,
  onAbort,
}: {
  isReachable: boolean
  isSessionActive: boolean
  onSend: (content: string) => void
  onAbort: () => void
}) {
  const tokens = useTokens()
  const [draft, setDraft] = useState('')

  const trimmed = draft.trim()
  const canSend = isReachable && trimmed.length > 0

  const handleSend = () => {
    if (!canSend) return
    setDraft('')
    onSend(trimmed)
  }

  return (
    <View className="border-t border-borderMuted bg-background px-3 pb-2 pt-2">
      {!isReachable ? (
        <View className="mb-2 rounded border border-borderMuted bg-surface px-3 py-2">
          <AppText variant="text-12-regular" className="text-textMuted">
            This session isn&apos;t connected to a desktop client.
          </AppText>
        </View>
      ) : null}

      <View className="flex-row items-end gap-2">
        <TextInput
          value={draft}
          onChangeText={setDraft}
          editable={isReachable}
          multiline
          placeholder="Message…"
          placeholderTextColor={tokens.textFaint}
          className="flex-1 rounded border border-border bg-surface px-3 py-2 text-foreground"
          style={{
            fontFamily: 'Geist-Regular',
            fontSize: 13,
            lineHeight: 20.8,
            letterSpacing: 0.14,
            maxHeight: 120,
            opacity: isReachable ? 1 : 0.5,
          }}
          accessibilityLabel="Message input"
        />

        {isSessionActive ? (
          <TouchableOpacity
            activeOpacity={0.7}
            onPress={onAbort}
            disabled={!isReachable}
            className="h-9 w-9 items-center justify-center rounded border border-destructive bg-transparent"
            style={{ opacity: isReachable ? 1 : 0.5 }}
            accessibilityRole="button"
            accessibilityLabel="Stop"
          >
            <SquareIcon size={13} color={tokens.destructive} weight="fill" />
          </TouchableOpacity>
        ) : null}

        <TouchableOpacity
          activeOpacity={0.7}
          onPress={handleSend}
          disabled={!canSend}
          className="h-9 w-9 items-center justify-center rounded bg-actionBg"
          style={{ opacity: canSend ? 1 : 0.4 }}
          accessibilityRole="button"
          accessibilityLabel="Send"
        >
          <ArrowUpIcon size={16} color={tokens.actionFg} weight="bold" />
        </TouchableOpacity>
      </View>
    </View>
  )
}
