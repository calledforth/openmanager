import { useRouter } from 'expo-router'
import { GearSixIcon, MagnifyingGlassIcon, NotePencilIcon } from 'phosphor-react-native'
import type { ReactNode } from 'react'
import { Text, View, type StyleProp, type ViewStyle } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { newSessionHref } from '../environment/landing-route'
import { usePhoneConnectionController } from '../environment/PhoneEnvironmentProvider'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { Glass, type GlassStrength } from './Glass'
import { tap } from './haptics'
import { Press } from './Press'

/** The dock's height: every piece is this tall, and the list keeps this clear. */
export const DOCK_HEIGHT = 56

const ROUND: StyleProp<ViewStyle> = {
  width: DOCK_HEIGHT,
  height: DOCK_HEIGHT,
  alignItems: 'center',
  justifyContent: 'center',
}

const WIDE: StyleProp<ViewStyle> = {
  height: DOCK_HEIGHT,
  flexDirection: 'row',
  alignItems: 'center',
  gap: 9,
  paddingLeft: 20,
  paddingRight: 24,
}

/**
 * The home's dock, where the pill nav was: Settings, New chat and Search as
 * three pieces of glass along the bottom edge, under the thumb. New chat is
 * the wide one in the middle, the thing the home is for; search sits at the
 * right as before; Settings at the left, the only other top-level place
 * (a page pushed from here, not a tab). Glass beside the home's content,
 * over it, so it blurs the rows scrolling under it.
 */
export function HomeDock() {
  const theme = usePhoneTheme()
  const router = useRouter()
  const controller = usePhoneConnectionController()
  const insets = useSafeAreaInsets()
  return (
    <View
      pointerEvents="box-none"
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: Math.max(insets.bottom, 16) + 12,
        flexDirection: 'row',
        justifyContent: 'center',
        alignItems: 'center',
        gap: 10,
        paddingHorizontal: 20,
      }}
    >
      <DockPiece label="Settings" shape={ROUND} onPress={() => router.push('/settings')}>
        <GearSixIcon size={22} color={theme.muted} />
      </DockPiece>
      <DockPiece
        label="New chat"
        shape={WIDE}
        strength="strong"
        // In the environment new sessions go to, read at the press.
        onPress={() => router.push(newSessionHref(controller.getState().selectedId) as never)}
      >
        <NotePencilIcon size={21} color={theme.fg} />
        <Text
          style={{
            fontFamily: 'Geist-Medium',
            fontSize: 15,
            lineHeight: 20,
            letterSpacing: -0.1,
            color: theme.fg,
          }}
        >
          New chat
        </Text>
      </DockPiece>
      <DockPiece label="Search" shape={ROUND} onPress={() => router.push('/search')}>
        <MagnifyingGlassIcon size={22} color={theme.fg} />
      </DockPiece>
    </View>
  )
}

/** One piece of the dock. Pressed, it dims, as the header's glass buttons do. */
function DockPiece({
  label,
  shape,
  strength = 'glass',
  onPress,
  children,
}: {
  label: string
  shape: StyleProp<ViewStyle>
  strength?: GlassStrength
  onPress: () => void
  children: ReactNode
}) {
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() => {
        tap()
        onPress()
      }}
      style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
    >
      <Glass strength={strength} shadow="float" contentStyle={shape}>
        {children}
      </Glass>
    </Press>
  )
}
