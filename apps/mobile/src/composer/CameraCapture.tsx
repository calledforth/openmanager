import { CameraView, useCameraPermissions } from 'expo-camera'
import { ArrowsClockwiseIcon, CameraIcon, XIcon } from 'phosphor-react-native'
import { useEffect, useRef, useState } from 'react'
import { BackHandler, Linking, Platform, View } from 'react-native'
import Animated from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { AppText } from '../components/ui/AppText'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { tap } from '../ui/haptics'
import { IconButton } from '../ui/IconButton'
import { Press } from '../ui/Press'
import { EXPAND_IN, EXPAND_OUT } from './ExpandedComposer'
import type { CapturedPhoto } from './model'

/**
 * A photo for the composer, from the camera: the feed full screen, a
 * shutter, the other camera, and close. The shot is handed over as a JPEG
 * file the composer uploads at once. Photos from the gallery need the photo
 * picker module, which this build does not carry.
 */
export function CameraCapture({
  onPhoto,
  onClose,
}: {
  onPhoto: (photo: CapturedPhoto) => void
  onClose: () => void
}) {
  const theme = usePhoneTheme()
  const insets = useSafeAreaInsets()
  const camera = useRef<CameraView>(null)
  const [permission, requestPermission] = useCameraPermissions()
  const [facing, setFacing] = useState<'back' | 'front'>('back')
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose()
      return true
    })
    return () => subscription.remove()
  }, [onClose])

  const shoot = async () => {
    if (!camera.current || busy) return
    setBusy(true)
    setFailure(null)
    try {
      const picture = await camera.current.takePictureAsync({ quality: 0.8, exif: false })
      onPhoto({
        uri: picture.uri,
        name: `Photo ${new Date().toISOString()}.jpg`,
        mimeType: 'image/jpeg',
      })
      onClose()
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'The photo was not taken.')
    } finally {
      setBusy(false)
    }
  }

  const granted = permission?.granted ?? false
  const blocked = permission ? !permission.granted && !permission.canAskAgain : false
  const web = Platform.OS === 'web'
  return (
    <Animated.View
      entering={EXPAND_IN}
      exiting={EXPAND_OUT}
      accessibilityViewIsModal
      style={{ position: 'absolute', inset: 0, backgroundColor: theme.bg }}
    >
      {granted && !web ? (
        <CameraView
          ref={camera}
          style={{ flex: 1 }}
          facing={facing}
          onCameraReady={() => setReady(true)}
        />
      ) : (
        <View
          style={{
            flex: 1,
            alignItems: 'center',
            justifyContent: 'center',
            gap: 14,
            paddingHorizontal: 40,
            backgroundColor: theme.bg,
          }}
        >
          <CameraIcon size={30} color={theme.muted} />
          <AppText variant="text-14-regular" style={{ color: theme.muted, textAlign: 'center' }}>
            {web
              ? 'Photos are taken in the app on your phone.'
              : blocked
                ? 'Camera access is off for OpenManager. Turn it on in Settings to attach a photo.'
                : 'Allow the camera to attach a photo.'}
          </AppText>
          {!web && permission ? (
            <Press
              accessibilityRole="button"
              accessibilityLabel={blocked ? 'Open Settings' : 'Allow camera'}
              onPress={() => {
                tap()
                if (blocked) void Linking.openSettings()
                else void requestPermission()
              }}
              style={({ pressed }) => ({
                paddingVertical: 10,
                paddingHorizontal: 18,
                borderRadius: 999,
                backgroundColor: pressed ? theme.actionHover : theme.actionBg,
              })}
            >
              <AppText variant="text-14-medium" style={{ color: theme.actionFg }}>
                {blocked ? 'Open Settings' : 'Allow camera'}
              </AppText>
            </Press>
          ) : null}
        </View>
      )}

      <View
        style={{
          position: 'absolute',
          top: insets.top + 6,
          left: 20,
          right: 20,
          flexDirection: 'row',
          justifyContent: 'space-between',
        }}
      >
        <IconButton label="Close the camera" onPress={onClose}>
          <XIcon size={18} color={theme.fg} />
        </IconButton>
        {granted && !web ? (
          <IconButton
            label="Switch camera"
            onPress={() => setFacing((side) => (side === 'back' ? 'front' : 'back'))}
          >
            <ArrowsClockwiseIcon size={18} color={theme.fg} />
          </IconButton>
        ) : null}
      </View>

      {granted && !web ? (
        <View
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: insets.bottom + 28,
            alignItems: 'center',
            gap: 10,
          }}
        >
          {failure ? (
            <AppText variant="text-12-regular" style={{ color: theme.fg }}>
              {failure}
            </AppText>
          ) : null}
          <Press
            accessibilityRole="button"
            accessibilityLabel="Take the photo"
            accessibilityState={{ disabled: !ready || busy, busy }}
            disabled={!ready || busy}
            onPress={() => {
              tap()
              void shoot()
            }}
            style={() => ({
              width: 72,
              height: 72,
              borderRadius: 36,
              padding: 5,
              backgroundColor: theme.glassStrong,
              opacity: !ready || busy ? 0.5 : 1,
            })}
          >
            {({ pressed }) => (
              <View
                style={{
                  flex: 1,
                  borderRadius: 31,
                  backgroundColor: pressed ? theme.muted : theme.fg,
                }}
              />
            )}
          </Press>
        </View>
      ) : null}
    </Animated.View>
  )
}
