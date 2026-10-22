import { ImageIcon, XIcon } from 'phosphor-react-native'
import { ActivityIndicator, Image, ScrollView, View } from 'react-native'
import Animated, { Easing, FadeIn, FadeOut } from 'react-native-reanimated'

import { usePhoneTheme } from '../theme/ThemeProvider'
import { tap } from '../ui/haptics'
import { Press } from '../ui/Press'
import type { ComposerImage } from './model'

/** A thumbnail fades in when attached and out when removed; short, on the UI thread. */
const THUMB_IN = FadeIn.duration(180).easing(Easing.out(Easing.quad))
const THUMB_OUT = FadeOut.duration(140).easing(Easing.in(Easing.quad))

const SIZE = 56

/**
 * The field's images: a thumbnail each, a spinner over one still uploading,
 * an image glyph for one that cannot be read, and a remove button.
 */
export function ImageStrip({
  images,
  onRemove,
}: {
  images: readonly ComposerImage[]
  onRemove: (id: string) => void
}) {
  const theme = usePhoneTheme()
  if (images.length === 0) return null
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ gap: 8, paddingHorizontal: 6, paddingTop: 6, paddingBottom: 2 }}
    >
      {images.map((image) => (
        <Animated.View
          key={image.id}
          entering={THUMB_IN}
          exiting={THUMB_OUT}
          style={{ width: SIZE, height: SIZE }}
        >
          <View
            style={{
              width: SIZE,
              height: SIZE,
              borderRadius: 12,
              overflow: 'hidden',
              backgroundColor: theme.hover,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {image.uri ? (
              <Image
                source={{ uri: image.uri }}
                resizeMode="cover"
                accessibilityLabel={image.name}
                style={{ width: SIZE, height: SIZE, opacity: image.uploading ? 0.6 : 1 }}
              />
            ) : image.failed ? (
              <ImageIcon size={18} color={theme.faint} />
            ) : null}
            {image.uploading ? (
              <View
                style={{
                  position: 'absolute',
                  inset: 0,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <ActivityIndicator size="small" color={theme.fg} />
              </View>
            ) : null}
          </View>
          <Press
            accessibilityRole="button"
            accessibilityLabel={`Remove ${image.name}`}
            hitSlop={8}
            onPress={() => {
              tap()
              onRemove(image.id)
            }}
            style={({ pressed }) => ({
              position: 'absolute',
              top: -5,
              right: -5,
              width: 20,
              height: 20,
              borderRadius: 10,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: pressed ? theme.active : theme.floatBg,
              boxShadow: theme.shadow.rest,
            })}
          >
            <XIcon size={11} color={theme.fg} weight="bold" />
          </Press>
        </Animated.View>
      ))}
    </ScrollView>
  )
}
