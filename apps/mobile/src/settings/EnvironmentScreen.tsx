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
import { useCallback, useRef, type ReactNode, type RefObject } from 'react'
import { ScrollView, Text, View } from 'react-native'
import { useEnvironmentClientOptional } from '@openmanager/app-core/logic'
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
import { coveredBySheet } from '../ui/a11y-focus'
import { SectionLabel } from '../ui/chrome'
import { ConfirmSheet } from '../ui/ConfirmSheet'
import { useGoBack } from '../ui/goBack'
import { IconButton } from '../ui/IconButton'
import { ConnectionPanel } from './ConnectionPanel'
import type { DeviceAdmin, DeviceAdminState } from './device-admin'
import { DeviceSheet } from './DeviceSheet'
import {
  confirmCopy,
  currentDevice,
  defaultPairingRoute,
  deviceRows as deviceRowViews,
} from './devices'
import { DevicesSection } from './DevicesSection'
import { sinceWords } from './EnvironmentCard'
import { PairSheet } from './PairSheet'
import { ProvidersSection } from './ProvidersSection'
import { TitlesSection, TitlesSheet } from './TitlesSheet'
import { usePageSheet, type PageSheet } from './page-sheet'
import { useDeviceAdmin, useTitleSetting } from './useSettingsStores'
import { ROUTE_ORDER_NOTE, pageStatusWords, routeRows, type RouteRowView } from './environments'
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
  const forgetRow = useRef<View>(null)
  const pairRow = useRef<View>(null)
  const revokeOthersRow = useRef<View>(null)
  const titlesRow = useRef<View>(null)
  const deviceRowRefs = useRef(new Map<string, RefObject<View | null>>())
  const deviceRef = useCallback((clientId: string) => {
    let ref = deviceRowRefs.current.get(clientId)
    if (!ref) {
      ref = { current: null }
      deviceRowRefs.current.set(clientId, ref)
    }
    return ref
  }, [])
  const environment = state.environments.find((item) => item.environmentId === environmentId)
  // The environment's own client, while it is the one this phone is on: its
  // devices, links, providers and settings can only be read over it.
  const appClient = useEnvironmentClientOptional()
  const client = state.selectedId === environmentId && environment ? appClient : null
  const [admin, adminState] = useDeviceAdmin(client, environmentId)
  const [titles, titlesState] = useTitleSetting(
    client?.supports('getEnvironmentSettings') ? client : null,
  )
  const [sheet, setSheet] = usePageSheet(adminState, {
    appUrl: environment?.appOrigin ?? null,
    titlesRead: Boolean(titlesState?.saved),
  })

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
  const inUse = selected ? (view.route?.endpoint ?? null) : null
  const routes = routeRows(environment, inUse)
  const pairingRoute = defaultPairingRoute(environment.routes, inUse)
  const canKeepCredential = selected && state.endpoint !== null
  const close = () => {
    admin?.clearActionError()
    setSheet(null)
  }

  return (
    <Page
      title={environment.label}
      sub={<EnvironmentSubLine environment={environment} selected={selected} view={view} />}
      onBack={goBack}
      overlay={
        sheet?.kind === 'forget' ? (
          <ConfirmSheet
            title={`Forget ${environment.label}?`}
            body="Removes it, its routes and this phone's access from this phone only. The computer keeps listing this phone until you revoke it there."
            confirmLabel="Forget"
            returnFocus={forgetRow}
            onCancel={() => setSheet(null)}
            onConfirm={() => {
              setSheet(null)
              controller.removeEnvironment(environmentId)
              // Forgetting the one in use leaves the phone on another, or on
              // none: either way the sessions home is where that shows.
              if (selected) router.navigate('/')
              else goBack()
            }}
          />
        ) : sheet?.kind === 'titles' ? (
          titles && titlesState ? (
            <TitlesSheet
              setting={titles}
              state={titlesState}
              returnFocus={titlesRow}
              onClose={() => setSheet(null)}
            />
          ) : null
        ) : sheet && admin && adminState ? (
          <AdminSheet
            sheet={sheet}
            admin={admin}
            state={adminState}
            canKeepCredential={canKeepCredential}
            routes={routes}
            defaultRoute={pairingRoute}
            appUrl={environment.appOrigin}
            refs={{ pairRow, revokeOthersRow, device: deviceRef }}
            onSheet={setSheet}
            onClose={close}
            onRotated={(credential) => {
              // The socket closes once the new credential is sent; saving it
              // redials with it. Never shown, never logged.
              if (state.endpoint) {
                controller.saveEnvironment({
                  environmentId,
                  endpoint: state.endpoint,
                  credential,
                })
              }
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
      {/* Under the routes, aligned with their titles, as in the mockup. */}
      <AppText
        variant="text-12-regular"
        style={{ color: theme.muted, paddingLeft: 56, paddingRight: 12, paddingVertical: 4 }}
      >
        {ROUTE_ORDER_NOTE}
      </AppText>
      <SettingsRow
        icon={<PlusIcon size={17} color={theme.muted} />}
        title="Add a route"
        sub="Scan or paste a pairing link that reaches it another way"
        onPress={() => router.push('/pair')}
      />

      {admin && adminState ? (
        <DevicesSection
          admin={admin}
          state={adminState}
          canKeepCredential={canKeepCredential}
          pairing={
            !environment.appOrigin
              ? {
                  ok: false,
                  why: 'This phone does not know the environment’s web address yet. Pair it again from a link first.',
                }
              : pairingRoute
                ? { ok: true }
                : { ok: false, why: 'This environment has no address another device can use' }
          }
          onDevice={(row) => {
            admin.clearActionError()
            setSheet({ kind: 'device', clientId: row.clientId })
          }}
          onPair={() => {
            admin.clearActionError()
            setSheet({ kind: 'pair', reopen: null })
          }}
          onRevokeOthers={(count) => {
            admin.clearActionError()
            setSheet({ kind: 'confirm', confirm: { kind: 'revoke_others', count } })
          }}
          onShowLink={(linkId) => {
            const url = admin.madeLink(linkId)
            const link = adminState.links?.find((item) => item.linkId === linkId)
            if (!url || !link) return
            admin.clearActionError()
            setSheet({ kind: 'pair', reopen: { link, url } })
          }}
          pairRowRef={pairRow}
          revokeOthersRef={revokeOthersRow}
          deviceRef={deviceRef}
        />
      ) : null}
      {client ? <ProvidersSection /> : null}
      {titlesState ? (
        <TitlesSection
          state={titlesState}
          rowRef={titlesRow}
          onOpen={() => setSheet({ kind: 'titles' })}
          onRetry={() => titles?.retry()}
        />
      ) : null}
      {!client ? (
        <AppText
          variant="text-12-regular"
          style={{ color: theme.muted, paddingLeft: 56, paddingRight: 12, paddingTop: 14 }}
        >
          {selected
            ? 'Its devices, providers and session titles show once the phone is connected.'
            : 'Use this environment to see its devices, providers and session titles.'}
        </AppText>
      ) : null}

      <View style={{ height: 20 }} />
      <SettingsRow
        icon={<TrashIcon size={17} color={theme.status.error} />}
        title="Forget this environment"
        sub="Removes it from this phone only"
        danger
        pressRef={forgetRow}
        onPress={() => setSheet({ kind: 'forget' })}
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
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <AppText
            variant="mono"
            numberOfLines={1}
            style={{ color: theme.muted, fontSize: 12, flexShrink: 1 }}
          >
            {route.host}
          </AppText>
          {route.inUse ? null : (
            <>
              <AppText variant="text-12-regular" style={{ color: theme.faint }}>
                ·
              </AppText>
              <AppText
                variant="text-12-regular"
                numberOfLines={1}
                style={{ color: theme.muted, flexShrink: 1 }}
              >
                {health}
              </AppText>
            </>
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
      {/* While a sheet is open, only the sheet can be read. */}
      <View style={{ flex: 1 }} {...coveredBySheet(Boolean(overlay))}>
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
      </View>
      {overlay}
    </View>
  )
}

/**
 * The device sheets: one device's actions, the confirmation in front of a
 * revoke or a rotation, and pairing another device. Each refusal is said in
 * the sheet that asked; nothing closes until the environment has answered.
 */
function AdminSheet({
  sheet,
  admin,
  state,
  canKeepCredential,
  routes,
  defaultRoute,
  appUrl,
  refs,
  onSheet,
  onClose,
  onRotated,
}: {
  sheet: PageSheet
  admin: DeviceAdmin
  state: DeviceAdminState
  canKeepCredential: boolean
  routes: readonly RouteRowView[]
  defaultRoute: string | null
  appUrl: string | null
  refs: {
    pairRow: RefObject<View | null>
    revokeOthersRow: RefObject<View | null>
    device: (clientId: string) => RefObject<View | null>
  }
  onSheet: (sheet: PageSheet) => void
  onClose: () => void
  onRotated: (credential: string) => void
}) {
  const list = state.list
  if (sheet.kind === 'device') {
    const row = list
      ? deviceRowViews(list, Date.now(), { canKeepCredential }).find(
          (item) => item.clientId === sheet.clientId,
        )
      : undefined
    // Revoked meanwhile (here or elsewhere): there is nothing left to act on.
    if (!row) return null
    return (
      <DeviceSheet
        row={row}
        busy={state.busy?.kind === 'rename'}
        error={state.failed?.kind === 'rename' ? state.actionError : null}
        returnFocus={refs.device(row.clientId)}
        onRename={(label) => admin.rename(row.clientId, label)}
        onRevoke={() => {
          admin.clearActionError()
          onSheet({
            kind: 'confirm',
            confirm: { kind: 'revoke', clientId: row.clientId, label: row.label },
          })
        }}
        onRotate={() => {
          admin.clearActionError()
          onSheet({ kind: 'confirm', confirm: { kind: 'rotate' } })
        }}
        onClose={onClose}
      />
    )
  }
  if (sheet.kind === 'confirm') {
    const { confirm } = sheet
    const copy = confirmCopy(confirm)
    const busy = state.busy !== null
    const returnFocus =
      confirm.kind === 'revoke_others'
        ? refs.revokeOthersRow
        : confirm.kind === 'revoke'
          ? refs.device(confirm.clientId)
          : undefined
    return (
      <ConfirmSheet
        title={copy.title}
        body={copy.body}
        confirmLabel={busy ? `${copy.action}…` : copy.action}
        busy={busy}
        error={state.failed && state.failed.kind !== 'revoke_link' ? state.actionError : null}
        returnFocus={returnFocus}
        onCancel={onClose}
        onConfirm={() => {
          const run =
            confirm.kind === 'revoke'
              ? admin.revoke(confirm.clientId)
              : confirm.kind === 'revoke_others'
                ? admin.revokeOthers()
                : admin.rotate().then((credential) => {
                    if (credential) onRotated(credential)
                    return credential !== null
                  })
          void run.then((done) => {
            if (done) onClose()
          })
        }}
      />
    )
  }
  if (sheet.kind === 'pair' && list && appUrl) {
    const here = currentDevice(list)
    if (!here) return null
    return (
      <PairSheet
        admin={admin}
        state={state}
        held={here.capabilities}
        routes={routes}
        defaultRoute={defaultRoute}
        appUrl={appUrl}
        reopen={sheet.reopen}
        returnFocus={refs.pairRow}
        onClose={onClose}
      />
    )
  }
  return null
}
