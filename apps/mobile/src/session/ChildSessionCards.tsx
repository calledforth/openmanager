import { useRouter } from 'expo-router'
import { CaretRightIcon } from 'phosphor-react-native'
import { memo } from 'react'
import { Pressable, View } from 'react-native'

import { AppText } from '../components/ui/AppText'
import { statusLineOf, statusMarkOf, type HomeSession } from '../home/rows'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { tap } from '../ui/haptics'
import { StatusMark } from '../ui/StatusMark'

/**
 * One delegated session (a subagent's transcript) as a card at the end of
 * its parent's transcript: its status mark and title as the environment
 * lists them. A tap opens it read-only on its own page.
 */
const ChildSessionCard = memo(function ChildSessionCard({ session }: { session: HomeSession }) {
  const theme = usePhoneTheme()
  const router = useRouter()
  const title = session.title?.trim() || 'Untitled subagent'
  const line = statusLineOf(session)
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open subagent ${title}`}
      onPress={() => {
        tap()
        router.push(`/session/${encodeURIComponent(session.externalId)}`)
      }}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderRadius: 12,
        backgroundColor: pressed ? theme.active : theme.hover,
      })}
    >
      <StatusMark mark={statusMarkOf(session)} size={14} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <AppText variant="text-14-medium" numberOfLines={1} style={{ color: theme.fg }}>
          {title}
        </AppText>
        <AppText variant="text-12-regular" numberOfLines={1} style={{ color: theme.muted }}>
          {line ? `Subagent · ${line}` : 'Subagent'}
        </AppText>
      </View>
      <CaretRightIcon size={14} color={theme.faint} weight="bold" />
    </Pressable>
  )
})

export const ChildSessionCards = memo(function ChildSessionCards({
  sessions,
}: {
  sessions: readonly HomeSession[]
}) {
  if (sessions.length === 0) return null
  return (
    <View style={{ gap: 6, paddingVertical: 7 }}>
      {sessions.map((session) => (
        <ChildSessionCard key={session.externalId} session={session} />
      ))}
    </View>
  )
})
