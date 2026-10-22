import { useRouter } from 'expo-router'
import {
  ArrowsLeftRightIcon,
  CaretLeftIcon,
  DesktopIcon,
  GlobeIcon,
  PlusIcon,
  TrashIcon,
  WifiHighIcon,
} from 'phosphor-react-native'
import { useState, type ReactNode } from 'react'
import { ScrollView, Text, View } from 'react-native'
import Animated, { FadeIn } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { AppText } from '../components/ui/AppText'
import { phoneConnectionView, type PhoneConnectionView } from '../environment/connection-ui'
import type { PhoneEnvironment } from '../environment/controller'
import {
  usePhoneConnection,
  usePhoneConnectionController,
} from '../environment/PhoneEnvironmentProvider'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { SectionLabel } from '../ui/chrome'
import { ConfirmSheet } from '../ui/ConfirmSheet'
import { useGoBack } from '../ui/goBack'
import { IconButton } from '../ui/IconButton'
import { ConnectionPanel } from './ConnectionPanel'
import { sinceWords } from './EnvironmentCard'
import { pageStatusWords, routeRows, type RouteRowView } from './environments'
import { Dot, Pill, SettingsRow, toneColor } from './SettingsRow'

const WORDS_IN = FadeIn.duration(180)

/**
 * One saved environment: where the phone stands with it, its routes in the
 * order the phone asks them (the one in use marked, each with what the phone
 * last learned about it), adding a route (the pairing screen), switching to
 * it, and forgetting it. Everything here is this phone's own record; nothing
 * the environment owns is shown or changed.
 */
export function EnvironmentScreen({ environmentId }: { environmentId: string }) {
  const theme = usePhoneTheme()
  const router = useRouter()
  const goBack = useGoBack()
  const state = usePhoneConnection()
  const controller = usePhoneConnectionController()
  const [forgetting, setForgetting] = useState(false)
  const environment = state.environments.find((item) => item.environmentId === environmentId)

  if (!environment) {
    return (
      <Page
        title="Not on this phone"
        sub={<SubLine color={theme.faint} words="This environment is not saved here" />}
        onBack={goBack}
      >
        <SettingsRow
          icon={<ArrowsLeftRightIcon size={17} color={theme.fg} />}
          title="Back to Settings"
          onPress={() => router.navigate('/settings')}
        />
      </Page>
    )
  }

  const selected = state.selectedId === environmentId
  const view = phoneConnectionView(state)
  const routes = routeRows(environment, selected ? (view.route?.endpoint ?? null) : null)

  return (
    <Page
      title={environment.label}
      sub={<EnvironmentSubLine environment={environment} selected={selected} view={view} />}
      onBack={goBack}
      overlay={
        forgetting ? (
          <ConfirmSheet
            title={`Forget ${environment.label}?`}
            body="Removes it, its routes and this phone's access from this phone only. The computer keeps listing this phone until you revoke it there."
            confirmLabel="Forget"
            onCancel={() => setForgetting(false)}
            onConfirm={() => {
              setForgetting(false)
              controller.removeEnvironment(environmentId)
              // Forgetting the one in use leaves the phone on another, or on
              // none: either way the sessions home is where that shows.
              if (selected) router.navigate('/')
              else goBack()
            }}
          />
        ) : null
      }
    >
      {selected && (view.ui.kind !== 'ready' || !environment.paired) ? (
        <View style={{ paddingHorizontal: 4, paddingTop: 6 }}>
          <ConnectionPanel view={view} />
        </View>
      ) : null}
      {!selected ? (
        <View style={{ paddingTop: 6 }}>
          <SettingsRow
            icon={<ArrowsLeftRightIcon size={17} color={theme.fg} />}
            title="Use this environment"
            sub="The phone connects to one environment at a time"
            onPress={() => {
              controller.selectEnvironment(environmentId)
              router.navigate('/')
            }}
          />
        </View>
      ) : null}

      <SectionLabel>Routes</SectionLabel>
      {routes.map((route) => (
        <RouteRow key={route.endpoint} route={route} />
      ))}
      <SettingsRow
        icon={<PlusIcon size={17} color={theme.muted} />}
        title="Add a route"
        sub="Scan or paste a pairing link that reaches it another way"
        onPress={() => router.push('/pair')}
      />
      <AppText variant="text-12-regular" style={{ color: theme.faint, paddingHorizontal: 12 }}>
        Asked in this order: this device and the local network first, then the rest.
      </AppText>

      <View style={{ height: 20 }} />
      <SettingsRow
        icon={<TrashIcon size={17} color={theme.status.error} />}
        title="Forget this environment"
        sub="Removes it from this phone only"
        danger
        onPress={() => setForgetting(true)}
      />
    </Page>
  )
}

function EnvironmentSubLine({
  environment,
  selected,
  view,
}: {
  environment: PhoneEnvironment
  selected: boolean
  view: PhoneConnectionView
}) {
  const theme = usePhoneTheme()
  if (!environment.paired) {
    return <SubLine color={theme.status.error} words="Needs pairing again" />
  }
  if (!selected) return <SubLine color={theme.faint} words="Not in use on this phone" />
  return <SubLine color={toneColor(theme, view.tone)} words={pageStatusWords(view)} />
}

function SubLine({ color, words }: { color: string; words: string }) {
  const theme = usePhoneTheme()
  return (
    <Animated.View
      key={words}
      entering={WORDS_IN}
      accessibilityLiveRegion="polite"
      style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 }}
    >
      <Dot color={color} />
      <AppText variant="text-13-regular" numberOfLines={1} style={{ color: theme.muted }}>
        {words}
      </AppText>
    </Animated.View>
  )
}

function RouteRow({ route }: { route: RouteRowView }) {
  const theme = usePhoneTheme()
  const Icon =
    route.title === 'This device' ? DesktopIcon : route.kind === 'lan' ? WifiHighIcon : GlobeIcon
  // What the phone last learned about a route it is not on, and when.
  const health =
    route.health === 'unknown' || !route.changedAt
      ? route.healthWords
      : `${route.healthWords} · ${sinceWords(route.changedAt)}`
  return (
    <SettingsRow
      selected={route.inUse}
      icon={<Icon size={17} color={route.inUse ? theme.fg : theme.muted} />}
      title={route.title}
      sub={
        <View>
          <AppText variant="mono" numberOfLines={1} style={{ color: theme.muted, fontSize: 12 }}>
            {route.host}
          </AppText>
          {route.inUse ? null : (
            <AppText
              variant="text-12-regular"
              numberOfLines={1}
              style={{ color: theme.faint, marginTop: 1 }}
            >
              {health}
            </AppText>
          )}
        </View>
      }
      trailing={
        route.inUse ? (
          <Pill>in use</Pill>
        ) : (
          <Dot
            color={
              route.health === 'available'
                ? theme.status.done
                : route.health === 'unknown'
                  ? theme.faint
                  : theme.status.error
            }
          />
        )
      }
    />
  )
}

/** A page above the tabs: back, the title and its status line, then a scrolling list. */
function Page({
  title,
  sub,
  onBack,
  overlay,
  children,
}: {
  title: string
  sub: ReactNode
  onBack: () => void
  overlay?: ReactNode
  children: ReactNode
}) {
  const theme = usePhoneTheme()
  const insets = useSafeAreaInsets()
  return (
    <View style={{ flex: 1, backgroundColor: theme.bg, paddingTop: insets.top + 6 }}>
      <View style={{ paddingHorizontal: 20 }}>
        <View style={{ height: 44, flexDirection: 'row', alignItems: 'center' }}>
          <IconButton label="Back" onPress={onBack}>
            <CaretLeftIcon size={18} color={theme.fg} />
          </IconButton>
        </View>
        <Text
          accessibilityRole="header"
          numberOfLines={2}
          style={{
            marginTop: 6,
            fontFamily: 'Geist-SemiBold',
            fontSize: 22,
            letterSpacing: -0.3,
            color: theme.fg,
          }}
        >
          {title}
        </Text>
        {sub}
      </View>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingHorizontal: 8,
          paddingTop: 6,
          paddingBottom: insets.bottom + 40,
        }}
      >
        {children}
      </ScrollView>
      {overlay}
    </View>
  )
}
