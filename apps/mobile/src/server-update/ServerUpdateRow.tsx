import {
  ArrowCircleUpIcon,
  CheckCircleIcon,
  HardDrivesIcon,
  WarningCircleIcon,
  XIcon,
} from 'phosphor-react-native'
import { useEffect } from 'react'
import { ActivityIndicator } from 'react-native'
import Animated, { Easing, FadeIn, FadeOut } from 'react-native-reanimated'

import { usePhoneConnection } from '../environment/PhoneEnvironmentProvider'
import { SettingsRow, toneColor } from '../settings/SettingsRow'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { SectionLabel } from '../ui/chrome'
import { Press } from '../ui/Press'
import { useServerUpdate, type PhoneServerUpdate } from './useServerUpdate'
import { serverUpdateRowView, showsServerUpdateCard } from './view'

const CARD_IN = FadeIn.duration(180).easing(Easing.out(Easing.quad))
const CARD_OUT = FadeOut.duration(150).easing(Easing.in(Easing.quad))
/** How long "updated" stays on the home before it goes by itself. */
const UPDATED_CARD_MS = 8_000

function RowIcon({ update }: { update: PhoneServerUpdate }) {
  const theme = usePhoneTheme()
  const view = serverUpdateRowView(update.notice, update.snapshot)
  const color = view ? toneColor(theme, view.tone) : theme.muted
  switch (update.notice.kind) {
    case 'updating':
      return <ActivityIndicator size="small" color={theme.muted} />
    case 'available':
      return <ArrowCircleUpIcon size={18} weight="fill" color={color} />
    case 'updated':
      return <CheckCircleIcon size={18} weight="fill" color={color} />
    case 'failed':
    case 'restart_required':
      return <WarningCircleIcon size={18} weight="fill" color={color} />
    default:
      return <HardDrivesIcon size={17} color={theme.muted} />
  }
}

/** On an environment's page: its server's version, and the update when there is one. */
export function ServerUpdateRow({
  environmentId,
  label,
  trailing,
  raised,
}: {
  environmentId: string
  /** Named on the home, where several environments' cards can stack. */
  label?: string
  trailing?: React.ReactNode
  raised?: boolean
}) {
  const update = useServerUpdate(environmentId)
  const view = serverUpdateRowView(update.notice, update.snapshot)
  if (!view) return null
  const { notice } = update
  const sub = label ? `${label} · ${view.sub}` : view.sub
  return (
    <SettingsRow
      icon={<RowIcon update={update} />}
      title={view.title}
      sub={sub}
      trailing={trailing}
      raised={raised}
      accessibilityLabel={`${view.title}. ${sub}`}
      onPress={
        view.action === 'update'
          ? () =>
              update.update(
                notice.kind === 'available' || notice.kind === 'failed' ? notice.to : undefined,
              )
          : view.action === 'check'
            ? update.check
            : undefined
      }
    />
  )
}

/** The home's cards: a server with an update, one updating, one just updated. */
export function ServerUpdateCards() {
  const { environments } = usePhoneConnection()
  return (
    <>
      {environments.map((environment) => (
        <ServerUpdateCard
          key={environment.environmentId}
          environmentId={environment.environmentId}
          label={environment.label}
        />
      ))}
    </>
  )
}

function ServerUpdateCard({ environmentId, label }: { environmentId: string; label: string }) {
  const theme = usePhoneTheme()
  const update = useServerUpdate(environmentId)
  const { notice, acknowledge } = update
  useEffect(() => {
    if (notice.kind !== 'updated') return
    const timer = setTimeout(acknowledge, UPDATED_CARD_MS)
    return () => clearTimeout(timer)
  }, [notice.kind, acknowledge])
  if (!showsServerUpdateCard(notice, update.dismissedVersion)) return null
  const canPutAway = notice.kind === 'available' || notice.kind === 'updated'
  return (
    <Animated.View
      entering={CARD_IN}
      exiting={CARD_OUT}
      accessibilityLabel={`${label} server`}
      style={{ marginHorizontal: 4, marginTop: 4, borderRadius: 16, backgroundColor: theme.hover }}
    >
      <ServerUpdateRow
        environmentId={environmentId}
        label={label}
        raised
        trailing={
          canPutAway ? (
            <Press
              accessibilityRole="button"
              accessibilityLabel="Not now"
              hitSlop={6}
              onPress={notice.kind === 'updated' ? acknowledge : update.dismiss}
              style={({ pressed }) => ({
                width: 30,
                height: 30,
                borderRadius: 15,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: pressed ? theme.active : 'transparent',
              })}
            >
              <XIcon size={14} color={theme.muted} />
            </Press>
          ) : undefined
        }
      />
    </Animated.View>
  )
}

/** The "Server" section of an environment's page, once its server has answered. */
export function ServerSection({ environmentId }: { environmentId: string }) {
  const update = useServerUpdate(environmentId)
  if (!serverUpdateRowView(update.notice, update.snapshot)) return null
  return (
    <>
      <SectionLabel>Server</SectionLabel>
      <ServerUpdateRow environmentId={environmentId} />
    </>
  )
}
