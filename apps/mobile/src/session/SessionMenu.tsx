import {
  ArrowUUpLeftIcon,
  CheckCircleIcon,
  CookingPotIcon,
  DotsThreeIcon,
  GearSixIcon,
  PencilSimpleIcon,
  PushPinIcon,
  PushPinSlashIcon,
  SparkleIcon,
  StopCircleIcon,
  type IconProps,
} from 'phosphor-react-native'
import { useEffect, useRef, type ComponentType } from 'react'
import { BackHandler, Pressable, StyleSheet, View } from 'react-native'
import Animated, { Easing, FadeIn, FadeOut } from 'react-native-reanimated'

import { AppText } from '../components/ui/AppText'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { Glass } from '../ui/Glass'
import { tap } from '../ui/haptics'
import { Press } from '../ui/Press'
import { conciseMenu, type SessionMenuItem, type SessionMenuItemId } from './session-menu'

/**
 * A row of the menu: a session's item (`session-menu.ts`, drawn with the
 * glyph its id names) or one a page adds with a glyph of its own (a draft's
 * Discard).
 */
export interface MenuItem {
  id: string
  label: string
  /** Why it cannot be used from here; null when it can. */
  disabledReason: string | null
  /** Stops or throws work away: drawn in the error tone. */
  destructive?: boolean
  icon?: ComponentType<IconProps>
}

const ICONS: Record<SessionMenuItemId, ComponentType<IconProps>> = {
  cook: CookingPotIcon,
  uncook: ArrowUUpLeftIcon,
  rename: PencilSimpleIcon,
  'regenerate-title': SparkleIcon,
  pin: PushPinIcon,
  unpin: PushPinSlashIcon,
  settle: CheckCircleIcon,
  unsettle: ArrowUUpLeftIcon,
  'stop-background': StopCircleIcon,
  'session-settings': GearSixIcon,
}

/** The glyph an item is drawn with: its own, else the one its id names. */
export const menuIconOf = (item: MenuItem) =>
  item.icon ?? ICONS[item.id as SessionMenuItemId] ?? DotsThreeIcon

/** The popover fades in and out: short, eased, on the UI thread. */
const MENU_IN = FadeIn.duration(160).easing(Easing.out(Easing.quad))
const MENU_OUT = FadeOut.duration(120).easing(Easing.in(Easing.quad))

/** Where the popover's left edge sits: under the title capsule, past Back. */
const MENU_LEFT = 20 + 36 + 8

/**
 * One line: the glyph and the word. An item that only waits (nothing can be
 * sent, or another command is out) is dimmed; why is said once above the
 * items, and to a screen reader on the row.
 */
export function MenuRow({
  item,
  onChoose,
}: {
  item: MenuItem | SessionMenuItem
  onChoose: () => void
}) {
  const theme = usePhoneTheme()
  const Icon = menuIconOf(item)
  const disabled = item.disabledReason !== null
  const tone = item.destructive ? theme.status.error : theme.fg
  return (
    <Press
      accessibilityRole="menuitem"
      accessibilityLabel={item.label}
      accessibilityHint={item.disabledReason ?? undefined}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={() => {
        tap()
        onChoose()
      }}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        minHeight: 44,
        paddingHorizontal: 12,
        borderRadius: 12,
        backgroundColor: pressed && !disabled ? theme.hover : 'transparent',
        opacity: disabled ? 0.45 : 1,
      })}
    >
      <Icon size={18} color={tone} />
      <AppText
        variant="text-14-regular"
        numberOfLines={1}
        style={{ color: tone, flex: 1, minWidth: 0 }}
      >
        {item.label}
      </AppText>
    </Press>
  )
}

function MenuNote({ text }: { text: string }) {
  const theme = usePhoneTheme()
  return (
    <AppText
      variant="text-12-regular"
      style={{ color: theme.muted, paddingHorizontal: 12, paddingTop: 8, paddingBottom: 4 }}
    >
      {text}
    </AppText>
  )
}

/**
 * The page's actions, opened from the title: a glass popover under the
 * header's capsule, over the page. A tap outside, or Android's Back, closes
 * it. Only what can be done is listed (`conciseMenu`), as in a row's actions
 * sheet; while nothing can be sent the items stay, dimmed, under why.
 */
export function SessionMenu({
  items,
  note,
  top,
  onChoose,
  onClose,
}: {
  items: readonly MenuItem[]
  /** Why nothing can be sent from here, said once above the items. */
  note: string | null
  /** Where the popover's top sits: just under the header's row. */
  top: number
  onChoose: (id: string) => void
  onClose: () => void
}) {
  // Android's Back closes the menu and goes no further while it is open.
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      close.current()
      return true
    })
    return () => subscription.remove()
  }, [])
  const shown = conciseMenu(items, note)
  return (
    <Animated.View
      entering={MENU_IN}
      exiting={MENU_OUT}
      style={StyleSheet.absoluteFill}
      pointerEvents="box-none"
    >
      <Pressable
        accessibilityLabel="Close the menu"
        accessibilityRole="button"
        onPress={onClose}
        style={StyleSheet.absoluteFill}
      />
      <View style={{ position: 'absolute', top, left: MENU_LEFT, width: 248 }}>
        <Glass strength="sheet" shadow="float" radius={16} contentStyle={{ padding: 6 }}>
          {note ? <MenuNote text={note} /> : null}
          <View accessibilityRole="menu">
            {shown.map((item) => (
              <MenuRow key={item.id} item={item} onChoose={() => onChoose(item.id)} />
            ))}
          </View>
        </Glass>
      </View>
    </Animated.View>
  )
}
