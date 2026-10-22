import * as Clipboard from 'expo-clipboard'
import * as Device from 'expo-device'
import { useRouter } from 'expo-router'
import { ArrowRightIcon, ClipboardTextIcon, LinkIcon, XIcon } from 'phosphor-react-native'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { CLIENT_LABEL_MAX_LENGTH } from '@openmanager/protocol'

import { AppText } from '../components/ui/AppText'
import { endpointHost } from '../environment/connected-route'
import {
  usePhoneConnection,
  usePhoneConnectionController,
} from '../environment/PhoneEnvironmentProvider'
import { readPhoneLabel, suggestPhoneLabel } from '../pairing/device-label'
import { readPairingLink } from '../pairing/link'
import { PairingSheet } from '../pairing/PairingSheet'
import { ScanPanel } from '../pairing/ScanPanel'
import { pairingSession } from '../pairing/session'
import { usePairing } from '../pairing/usePairing'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { useGoBack } from '../ui/goBack'
import { success, tap, warning } from '../ui/haptics'
import { IconButton } from '../ui/IconButton'

/**
 * Pairing: two doors and nothing else. Scan the QR code web's Pair-device
 * dialog shows, or paste its link; both read the link with the shared
 * parser and end on the same sheet. A phone that holds no token for the
 * environment trades the link's token for its own at the link's address; one
 * that does redeems the link over its own connection, and asks first before
 * a new address joins (the shared consent rule).
 */
export default function PairScreen() {
  const router = useRouter()
  const goBack = useGoBack()
  const insets = useSafeAreaInsets()
  const theme = usePhoneTheme()
  const controller = usePhoneConnectionController()
  const state = usePhoneConnection()
  const [pasted, setPasted] = useState('')
  const pairing = usePairing({
    controller,
    fetch: globalThis.fetch,
    onPaired: () => {
      success()
      // The link is used up; its token leaves the field too.
      setPasted('')
    },
    onFailed: warning,
  })
  useEffect(() => pairingSession.mountScreen(), [])
  const [label, setLabel] = useState(() =>
    suggestPhoneLabel({ modelName: Device.modelName, osName: Device.osName }),
  )

  const labelRead = readPhoneLabel(label)
  const pastedRead = useMemo(() => (pasted.trim() ? readPairingLink(pasted) : null), [pasted])
  const idle = pairing.phase.kind === 'idle'
  const ready = idle && labelRead.ok
  // The camera reports a code on every frame it sees it: one read per pairing.
  const scanned = useRef(false)
  useEffect(() => {
    if (idle) scanned.current = false
  }, [idle])

  const submitLink = (text: string, source: 'scan' | 'paste') => {
    if (!ready || !labelRead.ok) return
    pairing.submit(text, source, labelRead.label)
  }

  const onScan = (data: string) => {
    if (!ready || scanned.current) return
    scanned.current = true
    success()
    submitLink(data, 'scan')
  }

  const pasteFromClipboard = async () => {
    tap()
    const text = await Clipboard.getStringAsync().catch(() => '')
    if (text) setPasted(text.trim())
  }

  const reset = () => {
    setPasted('')
    pairing.reset()
  }

  return (
    <View className="flex-1" style={{ paddingTop: insets.top + 6, backgroundColor: theme.bg }}>
      <View className="flex-row items-center justify-between px-5" style={{ height: 44 }}>
        <Text
          accessibilityRole="header"
          style={{
            fontFamily: 'Geist-SemiBold',
            fontSize: 22,
            letterSpacing: -0.4,
            color: theme.fg,
          }}
        >
          Pair with a computer
        </Text>
        <IconButton label="Close" onPress={goBack}>
          <XIcon size={18} color={theme.fg} />
        </IconButton>
      </View>

      <KeyboardAvoidingView
        className="flex-1"
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          className="flex-1"
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{
            paddingHorizontal: 16,
            paddingTop: 10,
            paddingBottom: insets.bottom + 32,
            gap: 18,
          }}
        >
          <ScanPanel active={ready} found={pairing.source === 'scan' && !idle} onScan={onScan} />

          <View style={{ gap: 8 }}>
            <FieldLabel>Or paste the link</FieldLabel>
            <View className="flex-row items-center" style={{ gap: 8 }}>
              <View
                className="flex-1 flex-row items-center"
                style={{
                  gap: 10,
                  paddingLeft: 14,
                  paddingRight: 6,
                  height: 52,
                  borderRadius: 16,
                  backgroundColor: theme.hover,
                }}
              >
                <LinkIcon size={18} color={theme.muted} />
                <TextInput
                  accessibilityLabel="Pairing link"
                  value={pasted}
                  onChangeText={setPasted}
                  editable={idle}
                  placeholder="Paste a pairing link"
                  placeholderTextColor={theme.faint}
                  autoCapitalize="none"
                  autoCorrect={false}
                  spellCheck={false}
                  keyboardType={Platform.OS === 'ios' ? 'url' : 'default'}
                  returnKeyType="go"
                  onSubmitEditing={() => pasted.trim() && submitLink(pasted, 'paste')}
                  style={{
                    flex: 1,
                    fontFamily: 'Geist-Regular',
                    fontSize: 15,
                    color: theme.fg,
                    paddingVertical: 0,
                  }}
                />
                {pasted ? (
                  <FieldIcon label="Clear the link" onPress={() => setPasted('')}>
                    <XIcon size={16} color={theme.muted} />
                  </FieldIcon>
                ) : (
                  <FieldIcon label="Paste from clipboard" onPress={() => void pasteFromClipboard()}>
                    <ClipboardTextIcon size={20} color={theme.muted} />
                  </FieldIcon>
                )}
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Pair with this link"
                accessibilityState={{ disabled: !pasted.trim() || !ready }}
                disabled={!pasted.trim() || !ready}
                onPress={() => {
                  tap()
                  submitLink(pasted, 'paste')
                }}
                style={({ pressed }) => ({
                  width: 52,
                  height: 52,
                  borderRadius: 26,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: pressed ? theme.actionHover : theme.actionBg,
                  opacity: !pasted.trim() || !ready ? 0.35 : 1,
                })}
              >
                <ArrowRightIcon size={20} color={theme.actionFg} weight="bold" />
              </Pressable>
            </View>
            {pastedRead?.ok ? (
              <Hint>Reaches {endpointHost(pastedRead.link.payload.route)}</Hint>
            ) : (
              <Hint>
                On your computer: Settings, then Devices, then Pair a device. It shows the QR code
                and the link.
              </Hint>
            )}
          </View>

          <View style={{ gap: 8 }}>
            <FieldLabel>Name for this phone</FieldLabel>
            <TextInput
              accessibilityLabel="Name for this phone"
              value={label}
              onChangeText={setLabel}
              editable={idle}
              maxLength={CLIENT_LABEL_MAX_LENGTH}
              autoCorrect={false}
              placeholder="Phone"
              placeholderTextColor={theme.faint}
              style={{
                height: 52,
                borderRadius: 16,
                paddingHorizontal: 14,
                backgroundColor: theme.hover,
                fontFamily: 'Geist-Regular',
                fontSize: 15,
                color: theme.fg,
              }}
            />
            {labelRead.ok ? (
              <Hint>
                Shown on your computer's Devices list. A link made with a name keeps that name.
              </Hint>
            ) : (
              <Hint tone="error">{labelRead.problem}</Hint>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>

      <PairingSheet
        pairing={{ ...pairing, reset }}
        state={state}
        linkRoute={pairing.route}
        onOpenSessions={() => {
          reset()
          // Off the modal, then to the Sessions tab whichever tab it was opened from.
          if (router.canDismiss()) router.dismissAll()
          router.navigate('/')
        }}
        onClose={() => {
          reset()
          goBack()
        }}
      />
    </View>
  )
}

function FieldLabel({ children }: { children: string }) {
  const theme = usePhoneTheme()
  return (
    <AppText
      variant="text-11-medium"
      style={{ color: theme.faint, letterSpacing: 0.3, paddingLeft: 4 }}
    >
      {children.toUpperCase()}
    </AppText>
  )
}

function Hint({ children, tone }: { children: React.ReactNode; tone?: 'error' }) {
  const theme = usePhoneTheme()
  return (
    <AppText
      variant="text-12-regular"
      style={{ color: tone === 'error' ? theme.status.error : theme.faint, paddingHorizontal: 4 }}
    >
      {children}
    </AppText>
  )
}

function FieldIcon({
  label,
  onPress,
  children,
}: {
  label: string
  onPress: () => void
  children: React.ReactNode
}) {
  const theme = usePhoneTheme()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      onPress={onPress}
      style={({ pressed }) => ({
        width: 40,
        height: 40,
        borderRadius: 12,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: pressed ? theme.active : 'transparent',
      })}
    >
      {children}
    </Pressable>
  )
}
