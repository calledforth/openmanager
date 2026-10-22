import { CheckIcon, LinkIcon, ProhibitIcon, WarningIcon } from 'phosphor-react-native'
import type { ReactNode } from 'react'
import { ActivityIndicator, View } from 'react-native'

import { AppText } from '../components/ui/AppText'
import { connectedRoute, endpointHost, selectedEnvironment } from '../environment/connected-route'
import type { PhoneConnectionState, PhoneConnectionStatus } from '../environment/controller'
import { ROUTE_KIND_LABELS } from '../environment/route-order'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { Sheet } from '../ui/Sheet'
import { ActionButton } from './ActionButton'
import { describePairingFailure } from './failures'
import type { Pairing, PairingPhase } from './usePairing'

/** What the controller is doing, for the route row while the socket is not up yet. */
const STATUS_WORDS: Record<PhoneConnectionStatus, string> = {
  starting: 'Starting…',
  no_environment: 'Not saved',
  searching: 'Looking for a route…',
  connecting: 'Connecting…',
  connected: 'Connected',
  waiting: 'Not reachable yet; trying again',
  held: 'Paused while the app is in the background',
  offline: 'This phone is offline',
  unauthorized: 'The environment refused this phone',
  incompatible_protocol: 'The environment needs an update',
}

/**
 * The sheet over the pairing screen for every state after a link was read:
 * connecting, the consent question, paired (naming the route the controller
 * landed on), nothing added, or why it failed and what to do next.
 */
export function PairingSheet({
  pairing,
  state,
  linkRoute,
  onOpenSessions,
  onClose,
}: {
  pairing: Pairing
  state: PhoneConnectionState
  /** The route the link named, while one is being used. */
  linkRoute: string | null
  onOpenSessions: () => void
  onClose: () => void
}) {
  const { phase } = pairing
  if (phase.kind === 'idle') return null
  const dismissible = phase.kind === 'failed' || phase.kind === 'declined'
  return (
    <Sheet onDismiss={dismissible ? pairing.reset : undefined}>
      <SheetBody
        phase={phase}
        pairing={pairing}
        state={state}
        linkRoute={linkRoute}
        onOpenSessions={onOpenSessions}
        onClose={onClose}
      />
    </Sheet>
  )
}

function SheetBody({
  phase,
  pairing,
  state,
  linkRoute,
  onOpenSessions,
  onClose,
}: {
  phase: Exclude<PairingPhase, { kind: 'idle' }>
  pairing: Pairing
  state: PhoneConnectionState
  linkRoute: string | null
  onOpenSessions: () => void
  onClose: () => void
}) {
  const theme = usePhoneTheme()
  const host = linkRoute ? endpointHost(linkRoute) : 'the computer'
  switch (phase.kind) {
    case 'connecting': {
      const label = phase.label ?? 'the environment'
      const body =
        phase.step === 'exchanging'
          ? `Trading the link for this phone's own access at ${host}.`
          : phase.step === 'checking'
            ? `Checking that ${host} answers as ${label}.`
            : `Using the link over this phone's own connection to ${label}.`
      return (
        <Result
          mark={<ActivityIndicator color={theme.muted} />}
          markFill={theme.hover}
          title="Connecting…"
          body={body}
        />
      )
    }
    case 'consent':
      return (
        <>
          <Result
            mark={<LinkIcon size={26} color={theme.fg} />}
            markFill={theme.hover}
            title={`Add a new address for ${phase.label}?`}
            body={`This link reaches ${phase.label} at ${endpointHost(phase.route)}, an address this phone has not used for it. ${
              phase.sendsSavedCredential
                ? 'Adding it lets the phone send its saved access there.'
                : 'Adding it pairs this phone with whatever answers there as that computer.'
            } Only add it if you made this link or trust whoever sent it.`}
          />
          <Actions>
            <ActionButton label="Add address" onPress={pairing.accept} />
            <ActionButton label="Not now" tone="quiet" onPress={pairing.decline} />
          </Actions>
        </>
      )
    case 'declined':
      return (
        <>
          <Result
            mark={<ProhibitIcon size={26} color={theme.muted} />}
            markFill={theme.hover}
            title="Nothing was added"
            body={`This phone keeps reaching ${phase.label} the way it did. The link was not used.`}
          />
          <Actions>
            <ActionButton label="Done" onPress={onClose} />
          </Actions>
        </>
      )
    case 'failed': {
      const words = describePairingFailure(phase.failure)
      const next =
        words.next === 'retry' ? pairing.retry : words.next === 'new_link' ? pairing.reset : onClose
      return (
        <>
          <Result
            mark={<WarningIcon size={26} color={theme.status.error} weight="fill" />}
            markFill={theme.statusWash.error}
            title={words.title}
            body={words.body}
          />
          <Actions>
            <ActionButton label={words.nextLabel} onPress={next} />
            {words.next === 'close' ? null : (
              <ActionButton label="Close" tone="quiet" onPress={onClose} />
            )}
          </Actions>
        </>
      )
    }
    case 'paired': {
      const { paired } = phase
      const environment = state.environments.find(
        (item) => item.environmentId === paired.environmentId,
      )
      const label = environment?.label ?? 'your computer'
      const onIt = selectedEnvironment(state)?.environmentId === paired.environmentId
      const route = onIt ? connectedRoute(state) : null
      return (
        <>
          <Result
            mark={<CheckIcon size={26} color={theme.status.done} weight="bold" />}
            markFill={theme.statusWash.done}
            title={
              paired.how === 'redeemed' ? `Updated access to ${label}` : `Paired with ${label}`
            }
            body={`This phone is listed as “${paired.clientLabel}” on its Devices page. Your sessions stay on that computer; the phone talks to it.`}
          />
          <View style={{ gap: 2, marginTop: 4 }}>
            <Row
              name="Route"
              value={
                route
                  ? `${endpointHost(route.endpoint)} · ${ROUTE_KIND_LABELS[route.kind]}`
                  : STATUS_WORDS[onIt ? state.status : 'connecting']
              }
              mono={Boolean(route)}
              dot={route ? theme.status.done : theme.faint}
            />
          </View>
          <Actions>
            <ActionButton label="Open sessions" onPress={onOpenSessions} />
          </Actions>
        </>
      )
    }
  }
}

function Result({
  mark,
  markFill,
  title,
  body,
}: {
  mark: ReactNode
  markFill: string
  title: string
  body: string
}) {
  const theme = usePhoneTheme()
  return (
    <View style={{ alignItems: 'center', paddingHorizontal: 8, paddingBottom: 8 }}>
      <View
        style={{
          width: 56,
          height: 56,
          borderRadius: 28,
          backgroundColor: markFill,
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 10,
        }}
      >
        {mark}
      </View>
      <AppText
        accessibilityRole="header"
        variant="text-16-medium"
        style={{ color: theme.fg, textAlign: 'center' }}
      >
        {title}
      </AppText>
      <AppText
        variant="text-13-regular"
        style={{ color: theme.muted, textAlign: 'center', marginTop: 2, lineHeight: 19 }}
      >
        {body}
      </AppText>
    </View>
  )
}

function Row({
  name,
  value,
  mono,
  dot,
}: {
  name: string
  value: string
  mono?: boolean
  dot: string
}) {
  const theme = usePhoneTheme()
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingHorizontal: 14,
        paddingVertical: 12,
        borderRadius: 14,
        backgroundColor: theme.hover,
      }}
    >
      <AppText variant="text-13-regular" style={{ color: theme.muted, width: 52 }}>
        {name}
      </AppText>
      <AppText
        variant={mono ? 'mono' : 'text-13-regular'}
        numberOfLines={1}
        style={{ color: theme.fg, flex: 1 }}
      >
        {value}
      </AppText>
      <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: dot }} />
    </View>
  )
}

function Actions({ children }: { children: ReactNode }) {
  return <View style={{ gap: 4, marginTop: 12 }}>{children}</View>
}
