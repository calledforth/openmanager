import { useRouter } from 'expo-router'
import { useState } from 'react'
import { Pressable, ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import {
  THEME_FAMILIES,
  THEME_MODES,
  type ThemeMode as SchemeId,
} from '@openmanager/app-core/lib/theme-families'

import { AppText } from '../components/ui/AppText'
import { useTheme } from '../theme/ThemeProvider'
import { phoneTheme, type PhoneTheme } from '../theme/tokens'

/**
 * Every scheme, painted from the generated tokens, on one screen: the roles
 * the mockups use, the status marks, a sent bubble, a glass card over a
 * strip of content, and the floating shadows. Also the family and mode
 * switcher, which is what Settings → Appearance will become.
 */
export default function ThemePreview() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const { appearance, setAppearance, theme, scheme } = useTheme()
  const [showAll, setShowAll] = useState(false)

  return (
    <ScrollView
      className="flex-1 bg-canvas"
      contentContainerStyle={{ paddingTop: insets.top + 12, paddingBottom: insets.bottom + 40 }}
    >
      <View className="flex-row items-center justify-between px-5 pb-3">
        <Pressable onPress={() => router.back()} className="rounded-full bg-hover px-3 py-2">
          <AppText variant="text-13-medium" className="text-ink">
            Back
          </AppText>
        </Pressable>
        <AppText variant="text-12-regular" className="text-faint">
          {scheme}
        </AppText>
      </View>

      <Section title="Family">
        <View className="flex-row flex-wrap gap-3 px-5">
          {THEME_FAMILIES.map((family) => {
            const on = family.id === appearance.family
            const side = family[theme.colorScheme]
            return (
              <Pressable
                key={family.id}
                onPress={() => setAppearance({ ...appearance, family: family.id })}
                className="items-center gap-1.5"
              >
                <View
                  className="h-14 w-14 rounded-2xl"
                  style={{
                    backgroundColor: side.swatch.canvas,
                    borderWidth: on ? 2 : 1,
                    borderColor: on ? theme.fg : theme.rule,
                  }}
                >
                  <View
                    className="absolute bottom-2 left-2 h-2.5 w-6 rounded-full"
                    style={{ backgroundColor: side.swatch.ink }}
                  />
                  <View
                    className="absolute right-2 top-2 h-2.5 w-2.5 rounded-full"
                    style={{ backgroundColor: side.swatch.accent }}
                  />
                </View>
                <AppText variant="text-11-regular" className={on ? 'text-ink' : 'text-faint'}>
                  {family.label}
                </AppText>
              </Pressable>
            )
          })}
        </View>
      </Section>

      <Section title="Mode">
        <View className="mx-5 flex-row rounded-xl bg-hover p-1">
          {(['light', 'dark', 'system'] as const).map((mode) => {
            const on = mode === appearance.mode
            return (
              <Pressable
                key={mode}
                onPress={() => setAppearance({ ...appearance, mode })}
                className={`flex-1 items-center rounded-lg py-2 ${on ? 'bg-glass-strong' : ''}`}
                style={on ? { boxShadow: theme.shadow.rest } : undefined}
              >
                <AppText variant="text-13-medium" className={on ? 'text-ink' : 'text-muted'}>
                  {mode[0]!.toUpperCase() + mode.slice(1)}
                </AppText>
              </Pressable>
            )
          })}
        </View>
      </Section>

      <Section title="This scheme">
        <SchemeCard theme={theme} />
      </Section>

      <Section
        title="Every scheme"
        trailing={
          <Pressable onPress={() => setShowAll((v) => !v)}>
            <AppText variant="text-12-medium" className="text-muted">
              {showAll ? 'Hide' : 'Show all 12'}
            </AppText>
          </Pressable>
        }
      >
        {showAll
          ? THEME_MODES.map((id) => <SchemeCard key={id} theme={phoneTheme(id)} framed />)
          : null}
      </Section>
    </ScrollView>
  )
}

function Section({
  title,
  trailing,
  children,
}: {
  title: string
  trailing?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <View className="pt-5">
      <View className="flex-row items-center justify-between px-5 pb-2">
        <AppText variant="text-11-medium" className="text-faint">
          {title.toUpperCase()}
        </AppText>
        {trailing}
      </View>
      {children}
    </View>
  )
}

const STATUS_ORDER = ['working', 'background', 'needs', 'question', 'done', 'error'] as const

/** One scheme's roles, painted from its own PhoneTheme rather than the context. */
function SchemeCard({ theme, framed = false }: { theme: PhoneTheme; framed?: boolean }) {
  const t = theme
  return (
    <View
      className="mx-3 mb-3 overflow-hidden rounded-3xl"
      style={{
        backgroundColor: t.bg,
        borderWidth: framed ? 1 : 0,
        borderColor: t.rule,
      }}
    >
      <View className="flex-row items-center justify-between px-4 pt-4">
        <AppText variant="text-14-medium" style={{ color: t.fg }}>
          {t.scheme}
        </AppText>
        <AppText variant="text-11-regular" style={{ color: t.faint }}>
          {t.colorScheme}
        </AppText>
      </View>

      {/* Ink steps and fills. */}
      <View className="flex-row flex-wrap gap-2 px-4 pt-3">
        <Swatch label="bg" color={t.bg} ink={t.fg} outline={t.rule} />
        <Swatch label="surface-2" color={t.surface2} ink={t.fg} outline={t.rule} />
        <Swatch label="bubble" color={t.bubble} ink={t.fg} outline={t.rule} />
        <Swatch label="float" color={t.floatBg} ink={t.fg} outline={t.rule} />
        <Swatch label="action" color={t.actionBg} ink={t.actionFg} outline={t.rule} />
        <Swatch label="tint" color={t.tint} ink={t.bg} outline={t.rule} />
      </View>
      <View className="flex-row flex-wrap gap-2 px-4 pt-2">
        <Swatch label="fg" color={t.fg} ink={t.bg} outline={t.rule} />
        <Swatch label="muted" color={t.muted} ink={t.bg} outline={t.rule} />
        <Swatch label="faint" color={t.faint} ink={t.bg} outline={t.rule} />
        <Swatch label="hover" color={t.hover} ink={t.fg} outline={t.rule} />
        <Swatch label="active" color={t.active} ink={t.fg} outline={t.rule} />
        <Swatch label="rule" color={t.rule} ink={t.fg} outline={t.rule} />
      </View>

      {/* Status marks. */}
      <View className="flex-row items-center gap-3 px-4 pt-4">
        {STATUS_ORDER.map((key) => (
          <View key={key} className="items-center gap-1">
            <View className="h-3.5 w-3.5 rounded-full" style={{ backgroundColor: t.status[key] }} />
            <AppText variant="text-10-medium" style={{ color: t.faint }}>
              {key}
            </AppText>
          </View>
        ))}
      </View>
      <View className="flex-row gap-2 px-4 pt-3">
        <View className="rounded-lg px-2 py-1" style={{ backgroundColor: t.statusWash.done }}>
          <AppText variant="text-11-medium" style={{ color: t.status.done }}>
            Done wash
          </AppText>
        </View>
        <View className="rounded-lg px-2 py-1" style={{ backgroundColor: t.statusWash.error }}>
          <AppText variant="text-11-medium" style={{ color: t.status.error }}>
            Error wash
          </AppText>
        </View>
      </View>

      {/* A sent bubble, a reply, and glass over the two. */}
      <View className="px-4 pt-4">
        <View
          className="self-end rounded-2xl rounded-br-sm px-3 py-2"
          style={{ backgroundColor: t.bubble }}
        >
          <AppText variant="chat-user" style={{ color: t.fg }}>
            Carry the tool payloads across the protocol.
          </AppText>
        </View>
        <AppText
          variant="chat-assistant"
          className="pt-2"
          style={{ color: t.tokens['basis-text'] }}
        >
          The runtime already forwards rawInput and rawOutput; only the projector drops them.
        </AppText>
        <View
          className="-mt-5 mx-2 mb-1 flex-row items-center gap-2 rounded-3xl px-3 py-2.5"
          style={{ backgroundColor: t.glassStrong, boxShadow: t.shadow.rest }}
        >
          <AppText variant="text-13-regular" style={{ color: t.faint, flex: 1 }}>
            Ask anything…
          </AppText>
          <View
            className="h-7 w-7 items-center justify-center rounded-full"
            style={{ backgroundColor: t.actionBg }}
          >
            <AppText variant="text-12-medium" style={{ color: t.actionFg }}>
              ↑
            </AppText>
          </View>
        </View>
      </View>

      {/* Floating surface with the long shadow. */}
      <View className="px-4 pb-5 pt-5">
        <View
          className="rounded-2xl px-3 py-3"
          style={{ backgroundColor: t.floatBg, boxShadow: t.shadow.float }}
        >
          <AppText variant="text-12-medium" style={{ color: t.fg }}>
            Floating sheet
          </AppText>
          <AppText variant="text-11-regular" style={{ color: t.muted }}>
            float-bg with float-shadow
          </AppText>
        </View>
      </View>
    </View>
  )
}

function Swatch({
  label,
  color,
  ink,
  outline,
}: {
  label: string
  color: string
  ink: string
  outline: string
}) {
  return (
    <View
      className="h-12 w-[68px] justify-end rounded-xl p-1.5"
      style={{ backgroundColor: color, borderWidth: 1, borderColor: outline }}
    >
      <AppText variant="text-10-medium" style={{ color: ink }} numberOfLines={1}>
        {label}
      </AppText>
    </View>
  )
}
