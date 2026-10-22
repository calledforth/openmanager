import { useRef, type ReactNode, type RefObject } from 'react'
import { Text, View } from 'react-native'

import { AppText } from '../components/ui/AppText'
import { ActionButton } from '../pairing/ActionButton'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { Sheet } from './Sheet'

/**
 * Asking before something that cannot be undone: a glass sheet with the
 * question, what follows from it, and the two answers in words. A tap on the
 * scrim, and Android's Back, are the same as Cancel (while the action runs,
 * both wait for it). A screen reader starts on the question and goes back to
 * `returnFocus` (what opened it) after.
 */
export function ConfirmSheet({
  title,
  body,
  confirmLabel,
  tone = 'destructive',
  busy,
  error,
  children,
  returnFocus,
  onConfirm,
  onCancel,
}: {
  title: string
  body: string
  confirmLabel: string
  tone?: 'destructive' | 'primary'
  /** The confirmed action is running; both answers wait for it. */
  busy?: boolean
  /** What went wrong the last time it was confirmed. */
  error?: string | null
  children?: ReactNode
  /** What opened the sheet, for a screen reader's focus to go back to. */
  returnFocus?: RefObject<unknown>
  onConfirm: () => void
  onCancel: () => void
}) {
  const theme = usePhoneTheme()
  const question = useRef<Text>(null)
  return (
    <Sheet
      onDismiss={busy ? undefined : onCancel}
      onBack={() => {
        if (!busy) onCancel()
      }}
      initialFocus={question}
      returnFocus={returnFocus}
    >
      <View style={{ paddingHorizontal: 8, paddingBottom: 8, gap: 4 }}>
        <AppText
          ref={question}
          accessibilityRole="header"
          variant="text-16-medium"
          style={{ color: theme.fg, textAlign: 'center' }}
        >
          {title}
        </AppText>
        <AppText
          variant="text-13-regular"
          style={{ color: theme.muted, textAlign: 'center', lineHeight: 19 }}
        >
          {body}
        </AppText>
        {error ? (
          <AppText
            variant="text-13-regular"
            style={{ color: theme.status.error, textAlign: 'center', marginTop: 4 }}
          >
            {error}
          </AppText>
        ) : null}
      </View>
      {children}
      <View style={{ gap: 4, marginTop: 12 }}>
        <ActionButton label={confirmLabel} tone={tone} disabled={busy} onPress={onConfirm} />
        <ActionButton label="Cancel" tone="quiet" disabled={busy} onPress={onCancel} />
      </View>
    </Sheet>
  )
}
