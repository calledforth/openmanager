import * as Clipboard from 'expo-clipboard'
import {
  CheckIcon,
  CopyIcon,
  GlobeIcon,
  ShieldCheckIcon,
  WifiHighIcon,
} from 'phosphor-react-native'
import { useEffect, useRef, useState, type RefObject } from 'react'
import { Text, View } from 'react-native'
import Animated, { FadeIn } from 'react-native-reanimated'
import type { PairingLink } from '@openmanager/environment-client'
import { isLoopbackEnvironmentEndpoint } from '@openmanager/environment-client/connection'
import { useNow } from '@openmanager/app-core/lib/relative-time'
import type { AccessCapability } from '@openmanager/protocol'

import { AppText } from '../components/ui/AppText'
import { ActionButton } from '../pairing/ActionButton'
import { QrCode } from '../pairing/QrCode'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { tap } from '../ui/haptics'
import { Press } from '../ui/Press'
import { Sheet } from '../ui/Sheet'
import type { DeviceAdmin, DeviceAdminState, ShownPairingLink } from './device-admin'
import {
  expiryWords,
  grantWarnings,
  linkOutcome,
  offeredPresets,
  pairingGrant,
  type PairingPresetId,
} from './devices'
import type { RouteRowView } from './environments'
import { Segmented } from './Segmented'
import { SheetBody } from './SheetBody'
import { SettingsRow } from './SettingsRow'
import { Toggle } from './Toggle'

const STEP_IN = FadeIn.duration(180)
const ICON_IN = FadeIn.duration(150)

/**
 * Pairing another device from the phone, in one glass sheet: first what the
 * new device may do (web's two presets, Manage access on its own) and which
 * address it uses, then the single-use link as a QR code with the link to
 * copy, counting down, until a device uses it, it is withdrawn or it
 * expires. The environment answers the token once; the link lives in this
 * phone's memory only, so it can be shown again from the links list until
 * it stops working.
 */
export function PairSheet({
  admin,
  state,
  held,
  routes,
  defaultRoute,
  appUrl,
  reopen,
  returnFocus,
  onClose,
}: {
  admin: DeviceAdmin
  state: DeviceAdminState
  /** What this phone holds; a link can offer no more. */
  held: readonly AccessCapability[]
  routes: readonly RouteRowView[]
  defaultRoute: string | null
  appUrl: string
  /** Open on a link this phone made, instead of making a new one. */
  reopen: ShownPairingLink | null
  returnFocus?: RefObject<unknown>
  onClose: () => void
}) {
  const heading = useRef<Text>(null)
  const [shown, setShown] = useState<ShownPairingLink | null>(reopen)
  const busy = state.busy !== null
  return (
    <Sheet
      onDismiss={busy ? undefined : onClose}
      onBack={() => {
        if (!busy) onClose()
      }}
      initialFocus={heading}
      returnFocus={returnFocus}
    >
      {shown ? (
        <LinkStep
          key={shown.link.linkId}
          heading={heading}
          admin={admin}
          state={state}
          shown={shown}
          onAnother={() => {
            admin.clearActionError()
            setShown(null)
          }}
          onClose={onClose}
        />
      ) : (
        <SetupStep
          heading={heading}
          admin={admin}
          state={state}
          held={held}
          routes={routes}
          defaultRoute={defaultRoute}
          appUrl={appUrl}
          onCreated={setShown}
          onClose={onClose}
        />
      )}
    </Sheet>
  )
}

function Heading({
  heading,
  title,
  body,
}: {
  heading: RefObject<Text | null>
  title: string
  body: string
}) {
  const theme = usePhoneTheme()
  return (
    <View style={{ paddingHorizontal: 8, paddingBottom: 12, gap: 4 }}>
      <AppText
        ref={heading}
        accessibilityRole="header"
        accessibilityLiveRegion="polite"
        variant="text-16-medium"
        style={{ color: theme.fg, textAlign: 'center' }}
      >
        {title}
      </AppText>
      {body ? (
        <AppText
          variant="text-13-regular"
          style={{ color: theme.muted, textAlign: 'center', lineHeight: 19 }}
        >
          {body}
        </AppText>
      ) : null}
    </View>
  )
}

function SetupStep({
  heading,
  admin,
  state,
  held,
  routes,
  defaultRoute,
  appUrl,
  onCreated,
  onClose,
}: {
  heading: RefObject<Text | null>
  admin: DeviceAdmin
  state: DeviceAdminState
  held: readonly AccessCapability[]
  routes: readonly RouteRowView[]
  defaultRoute: string | null
  appUrl: string
  onCreated: (shown: ShownPairingLink) => void
  onClose: () => void
}) {
  const theme = usePhoneTheme()
  const presets = offeredPresets(held)
  const [preset, setPreset] = useState<PairingPresetId>(presets.at(-1)?.id ?? 'view')
  const [manage, setManage] = useState(false)
  const [route, setRoute] = useState(defaultRoute)
  const grant = pairingGrant(preset, manage, held)
  const warnings = grantWarnings(grant)
  const creating = state.busy?.kind === 'create_link'
  const error = state.failed?.kind === 'create_link' ? state.actionError : null
  const loopback = route !== null && isLoopbackEnvironmentEndpoint(route)

  return (
    <Animated.View key="setup" entering={STEP_IN}>
      <SheetBody
        footer={
          <View style={{ gap: 4, marginTop: 14 }}>
            <ActionButton
              label={creating ? 'Creating…' : 'Create link'}
              disabled={creating || route === null}
              onPress={() => {
                if (route === null) return
                void admin.createLink({ capabilities: grant, route, appUrl }).then((shown) => {
                  if (shown) onCreated(shown)
                })
              }}
            />
            <ActionButton label="Cancel" tone="quiet" disabled={creating} onPress={onClose} />
          </View>
        }
      >
        <Heading
          heading={heading}
          title="Pair another device"
          body="A single-use link for a phone or a browser. It gives that device its own access, which you can revoke here at any time."
        />
        {presets.length > 1 ? (
          <Segmented
            label="Access"
            options={presets.map((item) => ({ key: item.id, label: item.label }))}
            value={preset}
            onChange={setPreset}
          />
        ) : null}
        {held.includes('admin') ? (
          <SettingsRow
            raised
            icon={<ShieldCheckIcon size={17} color={theme.muted} />}
            title="Manage access"
            sub="Pair and revoke devices, like this one"
            trailing={
              <Toggle
                label="Manage access"
                value={manage}
                disabled={creating}
                onChange={() => setManage((value) => !value)}
              />
            }
          />
        ) : null}
        {warnings.map((warning) => (
          <AppText
            key={warning}
            variant="text-12-regular"
            style={{ color: theme.status.needs, paddingHorizontal: 12, paddingTop: 4 }}
          >
            {warning}
          </AppText>
        ))}
        {routes.length > 1 ? (
          <View style={{ marginTop: 10 }}>
            <AppText
              variant="text-11-medium"
              style={{
                color: theme.faint,
                letterSpacing: 0.3,
                paddingHorizontal: 12,
                paddingBottom: 2,
              }}
            >
              ADDRESS THE DEVICE USES
            </AppText>
            {routes.map((item) => {
              const Icon = item.kind === 'lan' ? WifiHighIcon : GlobeIcon
              const on = item.endpoint === route
              return (
                <SettingsRow
                  key={item.endpoint}
                  raised
                  selected={on}
                  icon={<Icon size={17} color={on ? theme.fg : theme.muted} />}
                  title={item.title}
                  sub={item.host}
                  accessibilityLabel={`${item.title}, ${item.host}${on ? ', chosen' : ''}`}
                  trailing={on ? <CheckIcon size={15} color={theme.fg} weight="bold" /> : null}
                  onPress={() => setRoute(item.endpoint)}
                />
              )
            })}
          </View>
        ) : null}
        {loopback ? (
          <AppText
            variant="text-12-regular"
            style={{ color: theme.status.needs, paddingHorizontal: 12, paddingTop: 4 }}
          >
            {`The device would reach the environment at ${route}, which only works on that computer. Add an address another device can reach first.`}
          </AppText>
        ) : null}
        {error ? (
          <AppText
            accessibilityRole="alert"
            variant="text-13-regular"
            style={{ color: theme.status.error, textAlign: 'center', marginTop: 8 }}
          >
            {error}
          </AppText>
        ) : null}
      </SheetBody>
    </Animated.View>
  )
}

/**
 * "Waiting for a device · expires in 4:12", ticking on its own so the QR code
 * and the sheet around it do not render again every second. Past the time on
 * this phone's clock it says the environment is being asked (the store reads
 * the links again then), or that it cannot be confirmed while offline.
 */
function Countdown({ link, connected }: { link: PairingLink; connected: boolean }) {
  const theme = usePhoneTheme()
  const now = useNow(1000)
  return (
    <AppText
      accessibilityRole="text"
      variant="text-12-regular"
      style={{ color: theme.muted, textAlign: 'center', marginTop: 8 }}
    >
      {`Waiting for a device · ${expiryWords(link, now, connected)}`}
    </AppText>
  )
}

function LinkStep({
  heading,
  admin,
  state,
  shown,
  onAnother,
  onClose,
}: {
  heading: RefObject<Text | null>
  admin: DeviceAdmin
  state: DeviceAdminState
  shown: ShownPairingLink
  onAnother: () => void
  onClose: () => void
}) {
  const theme = usePhoneTheme()
  // Only what the environment reports: a link past its time here stays
  // waiting, with its code and controls, until the environment says it expired.
  const link = state.links?.find((item) => item.linkId === shown.link.linkId) ?? shown.link
  const status = link.status
  const usedBy = link.usedByClientId
    ? state.list?.clients.find((item) => item.clientId === link.usedByClientId)?.label
    : undefined
  const outcome = linkOutcome(status, usedBy)
  const waiting = status === 'waiting'
  const withdrawing = state.busy?.kind === 'revoke_link'
  const error = state.failed?.kind === 'revoke_link' ? state.actionError : null

  return (
    <Animated.View key={status} entering={STEP_IN}>
      <SheetBody
        footer={
          <View style={{ gap: 4, marginTop: 14 }}>
            <ActionButton label="Done" onPress={onClose} disabled={withdrawing} />
            {waiting ? (
              <ActionButton
                label={withdrawing ? 'Withdrawing…' : 'Withdraw link'}
                tone="quiet"
                disabled={withdrawing}
                onPress={() => void admin.revokeLink(link.linkId)}
              />
            ) : (
              <ActionButton label="Pair another device" tone="quiet" onPress={onAnother} />
            )}
          </View>
        }
      >
        <Heading
          heading={heading}
          title={outcome.title}
          body={
            waiting
              ? 'Scan the code with the device’s camera, or send it the link. It works once.'
              : outcome.body
          }
        />
        {waiting ? (
          <>
            <View style={{ alignItems: 'center' }}>
              <QrCode value={shown.url} />
            </View>
            <CopyLink url={shown.url} />
            <Countdown link={link} connected={state.connected} />
          </>
        ) : null}
        {error ? (
          <AppText
            accessibilityRole="alert"
            variant="text-13-regular"
            style={{ color: theme.status.error, textAlign: 'center', marginTop: 8 }}
          >
            {error}
          </AppText>
        ) : null}
      </SheetBody>
    </Animated.View>
  )
}

/** The link in one line, middle cut, and copying it; the icon says when it was copied. */
function CopyLink({ url }: { url: string }) {
  const theme = usePhoneTheme()
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1400)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <View style={{ marginTop: 12, gap: 4 }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          paddingLeft: 14,
          paddingRight: 6,
          height: 48,
          borderRadius: 14,
          backgroundColor: theme.hover,
        }}
      >
        <AppText
          variant="mono"
          selectable
          numberOfLines={1}
          ellipsizeMode="middle"
          accessibilityLabel="Pairing link"
          style={{ flex: 1, color: theme.muted, fontSize: 12 }}
        >
          {url}
        </AppText>
        <Press
          accessibilityRole="button"
          accessibilityLabel={copied ? 'Copied' : 'Copy the link'}
          onPress={() => {
            tap()
            Clipboard.setStringAsync(url).then(
              () => {
                setFailed(false)
                setCopied(true)
              },
              () => setFailed(true),
            )
          }}
          style={({ pressed }) => ({
            width: 36,
            height: 36,
            borderRadius: 12,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: pressed ? theme.active : 'transparent',
          })}
        >
          <Animated.View key={copied ? 'copied' : 'copy'} entering={ICON_IN}>
            {copied ? (
              <CheckIcon size={17} color={theme.status.done} weight="bold" />
            ) : (
              <CopyIcon size={17} color={theme.fg} />
            )}
          </Animated.View>
        </Press>
      </View>
      {failed ? (
        <AppText
          variant="text-12-regular"
          style={{ color: theme.status.error, textAlign: 'center' }}
        >
          Could not copy. Hold the link to select it.
        </AppText>
      ) : null}
    </View>
  )
}
