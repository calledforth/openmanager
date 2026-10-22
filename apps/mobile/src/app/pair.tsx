import * as Clipboard from 'expo-clipboard'
import { fetch as expoFetch } from 'expo/fetch'
import * as Device from 'expo-device'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { ArrowRightIcon, ClipboardTextIcon, LinkIcon, XIcon } from 'phosphor-react-native'
import { useEffect, useRef, useState } from 'react'
import { KeyboardAvoidingView, Platform, ScrollView, Text, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { CLIENT_LABEL_MAX_LENGTH } from '@openmanager/protocol'

import { AppText } from '../components/ui/AppText'
import { endpointHost } from '../environment/connected-route'
import {
  usePhoneConnection,
  usePhoneConnectionController,
} from '../environment/PhoneEnvironmentProvider'
import { readPhoneLabel, suggestPhoneLabel } from '../pairing/device-label'
import type { PairingIntent } from '../pairing/flow'
import { readPairingLink } from '../pairing/link'
import { PairingSheet } from '../pairing/PairingSheet'
import { ScanPanel } from '../pairing/ScanPanel'
import { pairingSession } from '../pairing/session'
import { usePairing } from '../pairing/usePairing'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { coveredBySheet } from '../ui/a11y-focus'
import { useGoBack } from '../ui/goBack'
import { success, tap, warning } from '../ui/haptics'
import { IconButton } from '../ui/IconButton'
import { Press } from '../ui/Press'

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
  // Opened as the connection's "Pair again": that environment refused this
  // phone's token, which is not sent again; the new link is exchanged.
  const { again } = useLocalSearchParams<{ again?: string }>()
  const againLabel = again
    ? (state.environments.find((item) => item.environmentId === again)?.label ?? null)
    : null
  const intent: PairingIntent =
    again && againLabel !== null ? { kind: 'repair', environmentId: again } : { kind: 'pair' }
  // The field is masked and uncontrolled: whatever is typed or pasted, a
  // whole link or part of one, lives in a ref and never in React state or on
  // screen. A link that reads is held there and the field names only its
  // address; anything else shows as dots until it is cleared or sent.
  const field = useRef<TextInput>(null)
  const text = useRef('')
  const [typed, setTyped] = useState(false)
  const [heldHost, setHeldHost] = useState<string | null>(null)
  const clearLink = () => {
    text.current = ''
    field.current?.clear()
    setTyped(false)
    setHeldHost(null)
  }
  const takeText = (input: string) => {
    text.current = input.trim()
    setTyped(text.current !== '')
    const read = readPairingLink(input)
    setHeldHost(read.ok ? endpointHost(read.link.payload.route) : null)
  }
  const pairing = usePairing({
    controller,
    // Expo's fetch on a phone, so the exchange can refuse redirects natively.
    fetch: Platform.OS === 'web' ? globalThis.fetch : (expoFetch as unknown as typeof fetch),
    onPaired: () => {
      success()
      // The link is used up; the phone lets go of it too.
      clearLink()
    },
    onFailed: warning,
  })
  useEffect(() => pairingSession.mountScreen(), [])
  const [label, setLabel] = useState(() =>
    suggestPhoneLabel({ modelName: Device.modelName, osName: Device.osName }),
  )

  const labelRead = readPhoneLabel(label)
  const idle = pairing.phase.kind === 'idle'
  // Nothing is used before the phone has read what it saved: an exchange
  // uses the link up, and its answer must have somewhere to go.
  const ready = idle && labelRead.ok && state.status !== 'starting'
  // The camera reports a code on every frame it sees it: one read per pairing.
  const scanned = useRef(false)
  useEffect(() => {
    if (idle) scanned.current = false
  }, [idle])

  const submitLink = (text: string, source: 'scan' | 'paste') => {
    if (!ready || !labelRead.ok) return
    pairing.submit(text, source, labelRead.label, intent)
  }

  const onScan = (data: string) => {
    if (!ready || scanned.current) return
    scanned.current = true
    success()
    submitLink(data, 'scan')
  }

  const pasteFromClipboard = async () => {
    tap()
    const clip = await Clipboard.getStringAsync().catch(() => '')
    const clipText = clip.trim()
    if (!clipText) return
    // A link takes its place in the field; anything else is used at once, so
    // the sheet says what is wrong with it instead of a field of dots.
    if (readPairingLink(clipText).ok) takeText(clipText)
    else submitLink(clipText, 'paste')
  }

  const reset = () => {
    clearLink()
    pairing.reset()
  }

  return (
    <View className="flex-1" style={{ paddingTop: insets.top + 6, backgroundColor: theme.bg }}>
      {/* While the sheet is up, only the sheet can be read. */}
      <View style={{ flex: 1 }} {...coveredBySheet(!idle)}>
        <View className="flex-row items-center justify-between px-5" style={{ height: 44 }}>
          <Text
            accessibilityRole="header"
            numberOfLines={1}
            style={{
              flexShrink: 1,
              fontFamily: 'Geist-SemiBold',
              fontSize: 22,
              letterSpacing: -0.4,
              color: theme.fg,
            }}
          >
            {againLabel !== null ? `Pair again with ${againLabel}` : 'Pair with a computer'}
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
                  {heldHost ? (
                    <AppText
                      accessibilityLabel={`Pairing link for ${heldHost}`}
                      variant="text-14-regular"
                      numberOfLines={1}
                      style={{ flex: 1, color: theme.fg }}
                    >
                      Pairing link for {heldHost}
                    </AppText>
                  ) : (
                    <TextInput
                      accessibilityLabel="Pairing link"
                      ref={field}
                      defaultValue=""
                      secureTextEntry
                      onChangeText={takeText}
                      editable={idle}
                      placeholder="Paste a pairing link"
                      placeholderTextColor={theme.faint}
                      autoCapitalize="none"
                      autoCorrect={false}
                      spellCheck={false}
                      keyboardType={Platform.OS === 'ios' ? 'url' : 'default'}
                      returnKeyType="go"
                      onSubmitEditing={() => typed && submitLink(text.current, 'paste')}
                      style={{
                        flex: 1,
                        fontFamily: 'Geist-Regular',
                        fontSize: 15,
                        color: theme.fg,
                        paddingVertical: 0,
                      }}
                    />
                  )}
                  {typed ? (
                    <FieldIcon label="Clear the link" onPress={clearLink}>
                      <XIcon size={16} color={theme.muted} />
                    </FieldIcon>
                  ) : (
                    <FieldIcon
                      label="Paste from clipboard"
                      onPress={() => void pasteFromClipboard()}
                    >
                      <ClipboardTextIcon size={20} color={theme.muted} />
                    </FieldIcon>
                  )}
                </View>
                <Press
                  accessibilityRole="button"
                  accessibilityLabel="Pair with this link"
                  accessibilityState={{ disabled: !typed || !ready }}
                  disabled={!typed || !ready}
                  onPress={() => {
                    tap()
                    submitLink(text.current, 'paste')
                  }}
                  style={({ pressed }) => ({
                    width: 52,
                    height: 52,
                    borderRadius: 26,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: pressed ? theme.actionHover : theme.actionBg,
                    opacity: !typed || !ready ? 0.35 : 1,
                  })}
                >
                  <ArrowRightIcon size={20} color={theme.actionFg} weight="bold" />
                </Press>
              </View>
              {heldHost ? (
                <Hint>Ready to pair. Nothing is sent until you go.</Hint>
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
      </View>

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
    <Press
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
    </Press>
  )
}
