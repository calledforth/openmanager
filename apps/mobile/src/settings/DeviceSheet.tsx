import { CheckIcon, KeyIcon, PencilSimpleIcon, ProhibitIcon, XIcon } from 'phosphor-react-native'
import { useRef, useState, type ReactNode, type RefObject } from 'react'
import { KeyboardAvoidingView, StyleSheet, Text, TextInput, View } from 'react-native'
import Animated, { FadeIn } from 'react-native-reanimated'
import { CLIENT_LABEL_MAX_LENGTH } from '@openmanager/protocol'

import { AppText } from '../components/ui/AppText'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { tap } from '../ui/haptics'
import { Press } from '../ui/Press'
import { Sheet } from '../ui/Sheet'
import type { DeviceRowView } from './devices'
import { SettingsRow } from './SettingsRow'

const STEP_IN = FadeIn.duration(180)

/**
 * One device's sheet: its name and how it stands, then what this phone may
 * do to it, as icon rows. Renaming happens in place in the sheet; revoking
 * and rotating hand over to their confirmation. While the environment
 * answers a rename the sheet waits; its refusal is said in the sheet.
 */
export function DeviceSheet({
  row,
  busy,
  error,
  returnFocus,
  onRename,
  onRevoke,
  onRotate,
  onClose,
}: {
  row: DeviceRowView
  busy: boolean
  error: string | null
  returnFocus?: RefObject<unknown>
  /** Resolves true once the environment took the name. */
  onRename: (label: string) => Promise<boolean>
  onRevoke: () => void
  onRotate: () => void
  onClose: () => void
}) {
  const theme = usePhoneTheme()
  const heading = useRef<Text>(null)
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(row.label)
  const trimmed = draft.trim()
  const save = async () => {
    if (!trimmed || busy) return
    if (trimmed === row.label) {
      setRenaming(false)
      return
    }
    if (await onRename(trimmed)) setRenaming(false)
  }
  return (
    <KeyboardAvoidingView
      behavior="padding"
      style={StyleSheet.absoluteFill}
      pointerEvents="box-none"
    >
      <Sheet
        onDismiss={busy ? undefined : onClose}
        onBack={() => {
          if (busy) return
          if (renaming) setRenaming(false)
          else onClose()
        }}
        initialFocus={heading}
        returnFocus={returnFocus}
      >
        <View style={{ paddingHorizontal: 44, paddingBottom: 10, gap: 4 }}>
          <AppText
            ref={heading}
            accessibilityRole="header"
            variant="text-16-medium"
            numberOfLines={2}
            style={{ color: theme.fg, textAlign: 'center' }}
          >
            {row.label}
          </AppText>
          <AppText
            variant="text-13-regular"
            style={{ color: theme.muted, textAlign: 'center', lineHeight: 19 }}
          >
            {row.isCurrent ? `This phone · ${row.sub}` : row.sub}
          </AppText>
        </View>
        {/* Closing the sheet, reachable by every screen reader (the scrim is not). */}
        <View style={{ position: 'absolute', top: 20, right: 12 }}>
          <FieldAction label="Close" disabled={busy} onPress={onClose}>
            <XIcon size={17} color={theme.muted} />
          </FieldAction>
        </View>
        {renaming ? (
          <Animated.View key="rename" entering={STEP_IN} style={{ gap: 8 }}>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
                paddingLeft: 14,
                paddingRight: 6,
                height: 52,
                borderRadius: 16,
                backgroundColor: theme.hover,
              }}
            >
              <TextInput
                accessibilityLabel="Device name"
                autoFocus
                value={draft}
                onChangeText={setDraft}
                editable={!busy}
                maxLength={CLIENT_LABEL_MAX_LENGTH}
                autoCorrect={false}
                spellCheck={false}
                returnKeyType="done"
                onSubmitEditing={() => void save()}
                placeholder="Device name"
                placeholderTextColor={theme.faint}
                style={{
                  flex: 1,
                  fontFamily: 'Geist-Regular',
                  fontSize: 15,
                  color: theme.fg,
                  paddingVertical: 0,
                }}
              />
              <FieldAction
                label="Cancel renaming"
                disabled={busy}
                onPress={() => setRenaming(false)}
              >
                <XIcon size={17} color={theme.muted} />
              </FieldAction>
              <FieldAction
                label={busy ? 'Saving the name' : 'Save the name'}
                filled
                disabled={busy || !trimmed}
                onPress={() => void save()}
              >
                <CheckIcon size={17} color={theme.actionFg} weight="bold" />
              </FieldAction>
            </View>
          </Animated.View>
        ) : (
          <Animated.View key="actions" entering={STEP_IN}>
            {row.canRename ? (
              <SettingsRow
                raised
                icon={<PencilSimpleIcon size={17} color={theme.fg} />}
                title="Rename"
                sub="The name every device sees in this list"
                onPress={() => {
                  setDraft(row.label)
                  setRenaming(true)
                }}
              />
            ) : null}
            {row.canRotate ? (
              <SettingsRow
                raised
                icon={<KeyIcon size={17} color={theme.fg} />}
                title="Rotate credential"
                sub="Replace the owner's credential; others using it reconnect with the new one"
                onPress={onRotate}
              />
            ) : null}
            {row.canRevoke ? (
              <SettingsRow
                raised
                danger
                icon={<ProhibitIcon size={17} color={theme.status.error} />}
                title="Revoke"
                sub="It loses access now and signs out"
                onPress={onRevoke}
              />
            ) : null}
          </Animated.View>
        )}
        {error ? (
          <AppText
            accessibilityRole="alert"
            variant="text-13-regular"
            style={{ color: theme.status.error, textAlign: 'center', marginTop: 8 }}
          >
            {error}
          </AppText>
        ) : null}
      </Sheet>
    </KeyboardAvoidingView>
  )
}

function FieldAction({
  label,
  filled,
  disabled,
  onPress,
  children,
}: {
  label: string
  filled?: boolean
  disabled?: boolean
  onPress: () => void
  children: ReactNode
}) {
  const theme = usePhoneTheme()
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={() => {
        tap()
        onPress()
      }}
      style={({ pressed }) => ({
        width: 40,
        height: 40,
        borderRadius: 12,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: filled
          ? pressed
            ? theme.actionHover
            : theme.actionBg
          : pressed
            ? theme.active
            : 'transparent',
        opacity: disabled ? 0.4 : 1,
      })}
    >
      {children}
    </Press>
  )
}
