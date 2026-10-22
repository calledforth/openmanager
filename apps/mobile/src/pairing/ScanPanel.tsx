import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera'
import { CameraIcon, FlashlightIcon, QrCodeIcon } from 'phosphor-react-native'
import { useState } from 'react'
import { Linking, Platform, Pressable, StyleSheet, View } from 'react-native'

import { AppText } from '../components/ui/AppText'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { Glass } from '../ui/Glass'
import { IconButton } from '../ui/IconButton'
import { tap } from '../ui/haptics'

export const SCAN_PANEL_HEIGHT = 320

/**
 * The camera, framed, with its controls in glass over the feed: a torch
 * toggle and a hint. It scans QR codes only, and only while `active` (the
 * screen is idle): a code read once stops it until the pairing is over.
 * Without camera access it asks for it in place; on web, where the app has
 * no scanner, it points at the paste field instead.
 */
export function ScanPanel({
  active,
  found,
  onScan,
}: {
  active: boolean
  /** A code was read: the frame shows it in the success colour. */
  found: boolean
  onScan: (data: string) => void
}) {
  const theme = usePhoneTheme()
  if (Platform.OS === 'web') {
    return (
      <Frame>
        <Placeholder
          icon={<QrCodeIcon size={30} color={theme.muted} />}
          text="Scanning works in the app on your phone. Paste the link below instead."
        />
      </Frame>
    )
  }
  return <NativeScan active={active} found={found} onScan={onScan} />
}

function NativeScan({
  active,
  found,
  onScan,
}: {
  active: boolean
  found: boolean
  onScan: (data: string) => void
}) {
  const theme = usePhoneTheme()
  const [permission, requestPermission] = useCameraPermissions()
  const [torch, setTorch] = useState(false)

  if (!permission) return <Frame />
  if (!permission.granted) {
    const blocked = !permission.canAskAgain
    return (
      <Frame>
        <Placeholder
          icon={<CameraIcon size={30} color={theme.muted} />}
          text={
            blocked
              ? 'Camera access is off for OpenManager. Turn it on in Settings, or paste the link below.'
              : 'Allow the camera to scan the QR code your computer shows.'
          }
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={blocked ? 'Open Settings' : 'Allow camera'}
          onPress={() => {
            tap()
            if (blocked) void Linking.openSettings()
            else void requestPermission()
          }}
          style={({ pressed }) => ({
            marginTop: 14,
            alignSelf: 'center',
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            paddingHorizontal: 16,
            height: 40,
            borderRadius: 999,
            backgroundColor: pressed ? theme.active : theme.hover,
          })}
        >
          <CameraIcon size={16} color={theme.fg} />
          <AppText variant="text-14-medium" style={{ color: theme.fg }}>
            {blocked ? 'Open Settings' : 'Allow camera'}
          </AppText>
        </Pressable>
      </Frame>
    )
  }

  return (
    <Frame>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        active={active}
        enableTorch={torch && active}
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={
          active ? (result: BarcodeScanningResult) => onScan(result.data) : undefined
        }
      />
      <Reticle found={found} />
      <View style={{ position: 'absolute', top: 12, right: 12 }}>
        <IconButton
          label={torch ? 'Turn the torch off' : 'Turn the torch on'}
          onPress={() => setTorch((on) => !on)}
        >
          <FlashlightIcon
            size={18}
            color={torch ? theme.tint : theme.fg}
            weight={torch ? 'fill' : 'regular'}
          />
        </IconButton>
      </View>
      <View style={{ position: 'absolute', left: 0, right: 0, bottom: 14, alignItems: 'center' }}>
        <Glass contentStyle={{ paddingHorizontal: 14, paddingVertical: 7 }}>
          <AppText variant="text-13-regular" style={{ color: theme.fg }}>
            Point at the QR code on your computer
          </AppText>
        </Glass>
      </View>
    </Frame>
  )
}

function Frame({ children }: { children?: React.ReactNode }) {
  const theme = usePhoneTheme()
  return (
    <View
      style={{
        height: SCAN_PANEL_HEIGHT,
        borderRadius: 28,
        overflow: 'hidden',
        backgroundColor: theme.surface2,
        justifyContent: 'center',
      }}
    >
      {children}
    </View>
  )
}

function Placeholder({ icon, text }: { icon: React.ReactNode; text: string }) {
  const theme = usePhoneTheme()
  return (
    <View style={{ alignItems: 'center', paddingHorizontal: 36, gap: 12 }}>
      <View
        style={{
          width: 64,
          height: 64,
          borderRadius: 20,
          backgroundColor: theme.hover,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {icon}
      </View>
      <AppText variant="text-14-regular" style={{ color: theme.muted, textAlign: 'center' }}>
        {text}
      </AppText>
    </View>
  )
}

const RETICLE = 220
const ARM = 34
const THICK = 3

/** Four corners drawn as fills, the success colour once a code is read. */
function Reticle({ found }: { found: boolean }) {
  const theme = usePhoneTheme()
  const color = found ? theme.status.done : theme.fg
  const corners = [
    { top: 0, left: 0 },
    { top: 0, right: 0 },
    { bottom: 0, left: 0 },
    { bottom: 0, right: 0 },
  ] as const
  return (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute',
        alignSelf: 'center',
        width: RETICLE,
        height: RETICLE,
      }}
    >
      {corners.map((corner, index) => (
        <View key={index} style={{ position: 'absolute', width: ARM, height: ARM, ...corner }}>
          <View
            style={{
              position: 'absolute',
              ...('top' in corner ? { top: 0 } : { bottom: 0 }),
              left: 0,
              right: 0,
              height: THICK,
              borderRadius: THICK,
              backgroundColor: color,
            }}
          />
          <View
            style={{
              position: 'absolute',
              ...('left' in corner ? { left: 0 } : { right: 0 }),
              top: 0,
              bottom: 0,
              width: THICK,
              borderRadius: THICK,
              backgroundColor: color,
            }}
          />
        </View>
      ))}
    </View>
  )
}
