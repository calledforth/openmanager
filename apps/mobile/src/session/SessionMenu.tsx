import {
  ArrowUUpLeftIcon,
  CheckCircleIcon,
  DotsThreeIcon,
  GearSixIcon,
  PencilSimpleIcon,
  PushPinIcon,
  PushPinSlashIcon,
  SparkleIcon,
  StopCircleIcon,
  type IconProps,
} from 'phosphor-react-native'
import type { ComponentType } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import Animated, { Easing, FadeIn, FadeOut } from 'react-native-reanimated'

import { AppText } from '../components/ui/AppText'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { Glass } from '../ui/Glass'
import { tap } from '../ui/haptics'
import { Press } from '../ui/Press'
import type { SessionMenuItem, SessionMenuItemId } from './session-menu'

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
  rename: PencilSimpleIcon,
  'regenerate-title': SparkleIcon,
  pin: PushPinIcon,
  unpin: PushPinSlashIcon,
  settle: CheckCircleIcon,
  unsettle: ArrowUUpLeftIcon,
  'stop-background': StopCircleIcon,
  'session-settings': GearSixIcon,
}

const iconOf = (item: MenuItem) => item.icon ?? ICONS[item.id as SessionMenuItemId] ?? DotsThreeIcon

/** The popover fades in and out: short, eased, on the UI thread. */
const MENU_IN = FadeIn.duration(160).easing(Easing.out(Easing.quad))
const MENU_OUT = FadeOut.duration(120).easing(Easing.in(Easing.quad))

/** Where the popover's left edge sits: under the title capsule, past Back. */
const MENU_LEFT = 20 + 36 + 8

export function MenuRow({
  item,
  said,
  onChoose,
}: {
  item: MenuItem | SessionMenuItem
  /** The reason the menu already says at its top: not repeated on the row. */
  said: string | null
  onChoose: () => void
}) {
  const theme = usePhoneTheme()
  const Icon = iconOf(item)
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
        paddingVertical: 8,
        borderRadius: 10,
        backgroundColor: pressed && !disabled ? theme.hover : 'transparent',
      })}
    >
      <View style={{ opacity: disabled ? 0.45 : 1 }}>
        <Icon size={18} color={tone} />
      </View>
      <View style={{ flex: 1, minWidth: 0, opacity: disabled ? 0.45 : 1 }}>
        <AppText variant="text-14-regular" numberOfLines={1} style={{ color: tone }}>
          {item.label}
        </AppText>
        {item.disabledReason && item.disabledReason !== said ? (
          <AppText variant="text-12-regular" numberOfLines={2} style={{ color: theme.muted }}>
            {item.disabledReason}
          </AppText>
        ) : null}
      </View>
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
 * header's capsule, over the page. A tap outside closes it. Items it cannot
 * do from here stay listed, dimmed, with why, and do not respond.
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
      <View style={{ position: 'absolute', top, left: MENU_LEFT, width: 256 }}>
        <Glass strength="sheet" shadow="float" radius={16} contentStyle={{ padding: 6 }}>
          {note ? <MenuNote text={note} /> : null}
          <View accessibilityRole="menu">
            {items.map((item) => (
              <MenuRow key={item.id} item={item} said={note} onChoose={() => onChoose(item.id)} />
            ))}
          </View>
        </Glass>
      </View>
    </Animated.View>
  )
}
