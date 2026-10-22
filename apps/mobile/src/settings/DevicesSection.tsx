import {
  ArrowClockwiseIcon,
  CloudIcon,
  DesktopIcon,
  DeviceMobileIcon,
  LinkSimpleIcon,
  LockSimpleIcon,
  QrCodeIcon,
  UserMinusIcon,
} from 'phosphor-react-native'
import type { Ref } from 'react'
import { View } from 'react-native'
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated'
import { useNow } from '@openmanager/app-core/lib/relative-time'

import { AppText } from '../components/ui/AppText'
import type { PhoneTheme } from '../theme/tokens'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { SectionLabel } from '../ui/chrome'
import { tap } from '../ui/haptics'
import { Press } from '../ui/Press'
import type { DeviceAdmin, DeviceAdminState } from './device-admin'
import {
  NO_ADMIN_NOTE,
  currentDevice,
  deviceRows,
  omittedNote,
  revocableOthers,
  waitingLinkRows,
  type DeviceRowView,
} from './devices'
import { Pill, SettingsRow } from './SettingsRow'

/** A row arriving or leaving with the environment's list: a short fade, the rest closing up. */
const ROW_IN = FadeIn.duration(180)
const ROW_OUT = FadeOut.duration(150)
const ROWS_SHIFT = LinearTransition.duration(200)

function kindIcon(row: DeviceRowView, theme: PhoneTheme) {
  const color = row.isCurrent ? theme.fg : theme.muted
  if (row.kind === 'owner') return <DesktopIcon size={17} color={color} />
  if (row.kind === 'cloud') return <CloudIcon size={17} color={color} />
  return <DeviceMobileIcon size={17} color={color} />
}

/** A quiet line under a group: a note, or what went wrong, with a retry when one helps. */
export function GroupNote({
  words,
  tone = 'muted',
  onRetry,
}: {
  words: string
  tone?: 'muted' | 'error'
  onRetry?: () => void
}) {
  const theme = usePhoneTheme()
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingLeft: 56,
        paddingRight: 12,
        paddingVertical: 4,
      }}
    >
      <AppText
        variant="text-12-regular"
        accessibilityRole={tone === 'error' ? 'alert' : undefined}
        style={{ flex: 1, color: tone === 'error' ? theme.status.error : theme.muted }}
      >
        {words}
      </AppText>
      {onRetry ? <RoundAction label="Try again" icon="retry" onPress={onRetry} /> : null}
    </View>
  )
}

/** A small round icon action at the end of a row: re-check, show the QR code. */
export function RoundAction({
  label,
  icon,
  onPress,
  disabled,
}: {
  label: string
  icon: 'retry' | 'qr'
  onPress: () => void
  disabled?: boolean
}) {
  const theme = usePhoneTheme()
  const Icon = icon === 'retry' ? ArrowClockwiseIcon : QrCodeIcon
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      hitSlop={6}
      onPress={() => {
        tap()
        onPress()
      }}
      style={({ pressed }) => ({
        width: 32,
        height: 32,
        borderRadius: 16,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: pressed ? theme.active : theme.hover,
        opacity: disabled ? 0.4 : 1,
      })}
    >
      <Icon size={15} color={theme.fg} />
    </Press>
  )
}

/** The mockup's "revoke" pill: a warning-coloured word on a fill. */
function RevokePill({
  label,
  onPress,
  disabled,
}: {
  label: string
  onPress: () => void
  disabled?: boolean
}) {
  const theme = usePhoneTheme()
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      hitSlop={8}
      onPress={() => {
        tap()
        onPress()
      }}
      style={({ pressed }) => ({
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 999,
        backgroundColor: pressed ? theme.active : theme.hover,
        opacity: disabled ? 0.4 : 1,
      })}
    >
      <AppText variant="text-12-regular" style={{ color: theme.status.needs }}>
        revoke
      </AppText>
    </Press>
  )
}

function Count({ children }: { children: string }) {
  const theme = usePhoneTheme()
  return (
    <AppText variant="text-12-regular" style={{ color: theme.muted }}>
      {children}
    </AppText>
  )
}

/**
 * The environment's paired devices and its waiting pairing links, as the
 * mockup's environment frame lists them: this phone marked "you", each row
 * opening what can be done to it, then pairing another device, revoking the
 * others, and the links still waiting with their "revoke" pill. Everything
 * shown is the environment's last report; rows come and go as it changes.
 */
export function DevicesSection({
  admin,
  state,
  canKeepCredential,
  pairing,
  onDevice,
  onPair,
  onRevokeOthers,
  onShowLink,
  pairRowRef,
  revokeOthersRef,
  deviceRef,
}: {
  admin: DeviceAdmin
  state: DeviceAdminState
  canKeepCredential: boolean
  /** Whether a link can be made here, or why not. */
  pairing: { ok: true } | { ok: false; why: string }
  onDevice: (row: DeviceRowView) => void
  onPair: () => void
  onRevokeOthers: (count: number) => void
  onShowLink: (linkId: string) => void
  pairRowRef: Ref<View>
  revokeOthersRef: Ref<View>
  deviceRef: (clientId: string) => Ref<View>
}) {
  const theme = usePhoneTheme()
  // A waiting link counts down by the second; otherwise "last seen" words move by minutes.
  const waiting = state.links?.some((link) => link.status === 'waiting') ?? false
  const now = useNow(waiting ? 1000 : 30_000)
  const list = state.list

  if (state.access === 'unsupported') return null
  if (state.access === 'denied') {
    return (
      <>
        <SectionLabel>Paired devices</SectionLabel>
        <SettingsRow
          icon={<LockSimpleIcon size={17} color={theme.muted} />}
          title="Managed from another device"
          sub={NO_ADMIN_NOTE}
        />
      </>
    )
  }
  if (!list) {
    return (
      <>
        <SectionLabel>Paired devices</SectionLabel>
        {state.loadError ? (
          <GroupNote words={state.loadError} tone="error" onRetry={admin.load} />
        ) : (
          <GroupNote words="Loading devices…" />
        )}
      </>
    )
  }

  const rows = deviceRows(list, now, { canKeepCredential })
  const others = revocableOthers(list)
  const here = currentDevice(list)
  const links = state.links
    ? waitingLinkRows(state.links, now, {
        connected: state.connected,
        currentClientId: list.currentClientId,
        deviceLabel: (clientId) => list.clients.find((item) => item.clientId === clientId)?.label,
        madeHere: (linkId) => admin.madeLink(linkId) !== undefined,
      })
    : []
  const withdrawing = state.busy?.kind === 'revoke_link'

  return (
    <>
      <SectionLabel trailing={<Count>{String(list.clients.length + list.omitted)}</Count>}>
        Paired devices
      </SectionLabel>
      {rows.map((row) => {
        const actionable = row.canRename || row.canRevoke || row.canRotate
        return (
          <Animated.View key={row.clientId} entering={ROW_IN} exiting={ROW_OUT} layout={ROWS_SHIFT}>
            <SettingsRow
              icon={kindIcon(row, theme)}
              title={row.label}
              sub={row.sub}
              accessibilityLabel={`${row.label}${row.isCurrent ? ', this phone' : ''}, ${row.sub}`}
              trailing={
                row.isCurrent ? (
                  <Pill>you</Pill>
                ) : row.kind === 'owner' ? (
                  <Pill>owner</Pill>
                ) : undefined
              }
              pressRef={deviceRef(row.clientId)}
              onPress={actionable ? () => onDevice(row) : undefined}
            />
          </Animated.View>
        )
      })}
      {list.omitted > 0 ? (
        <GroupNote words={omittedNote(list.omitted, here === undefined)} />
      ) : null}
      {here ? (
        <SettingsRow
          icon={<QrCodeIcon size={17} color={pairing.ok ? theme.fg : theme.faint} />}
          title="Pair another device"
          sub={pairing.ok ? 'Show a single-use QR code and link' : pairing.why}
          pressRef={pairRowRef}
          onPress={pairing.ok ? onPair : undefined}
        />
      ) : null}
      {others > 0 ? (
        <SettingsRow
          icon={<UserMinusIcon size={17} color={theme.muted} />}
          title="Revoke all other devices"
          sub={`${others === 1 ? '1 device' : `${others} devices`}; this phone and the owner keep access`}
          pressRef={revokeOthersRef}
          onPress={() => onRevokeOthers(others)}
        />
      ) : null}

      {links.length > 0 ? (
        <>
          <SectionLabel trailing={<Count>{`${links.length} active`}</Count>}>
            Pairing links
          </SectionLabel>
          {links.map((link) => (
            <Animated.View
              key={link.linkId}
              entering={ROW_IN}
              exiting={ROW_OUT}
              layout={ROWS_SHIFT}
            >
              <SettingsRow
                icon={<LinkSimpleIcon size={17} color={theme.muted} />}
                title={link.title}
                sub={link.sub}
                accessibilityLabel={`${link.title}, ${link.sub}${link.shownHere ? ', show the QR code' : ''}`}
                onPress={link.shownHere ? () => onShowLink(link.linkId) : undefined}
                trailing={
                  <RevokePill
                    label={`Withdraw the link for ${link.title}`}
                    disabled={withdrawing}
                    onPress={() => void admin.revokeLink(link.linkId)}
                  />
                }
              />
            </Animated.View>
          ))}
        </>
      ) : null}
      {state.linksError ? (
        <GroupNote
          words={`Could not read the pairing links: ${state.linksError}`}
          tone="error"
          onRetry={admin.refreshLinks}
        />
      ) : null}
      {/* A refused withdrawal is said here; other refusals show in their own sheet. */}
      {state.failed?.kind === 'revoke_link' && state.actionError ? (
        <GroupNote words={state.actionError} tone="error" />
      ) : null}
    </>
  )
}
