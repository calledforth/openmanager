import { useRouter } from 'expo-router'
import { CaretRightIcon } from 'phosphor-react-native'
import { memo } from 'react'
import { View } from 'react-native'

import { AppText } from '../components/ui/AppText'
import { sessionRowHref } from '../environment/landing-route'
import { statusLineOf, statusMarkOf, type HomeSession } from '../home/rows'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { tap } from '../ui/haptics'
import { Press } from '../ui/Press'
import { ProviderMark } from '../ui/ProviderMark'
import { StatusMark } from '../ui/StatusMark'

/**
 * One delegated session the transcript holds no subagent record for (one
 * started before subagents had cards), at the end of its parent's
 * transcript. Drawn as a subagent card is, so the two read as one kind of
 * thing: its status mark, its title, "Subagent", its provider's mark and,
 * on the right, how it stands when that needs saying. A tap opens it
 * read-only on its own page.
 */
const ChildSessionCard = memo(function ChildSessionCard({ session }: { session: HomeSession }) {
  const theme = usePhoneTheme()
  const router = useRouter()
  const title = session.title?.trim() || 'Untitled subagent'
  const line = statusLineOf(session)
  const mark = statusMarkOf(session)
  // Working and done say it with the glyph, as a subagent card does.
  const flag = line && mark !== 'working' && mark !== 'done' ? line : null
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel={`Open subagent ${title}${line ? `, ${line}` : ''}`}
      onPress={() => {
        tap()
        router.push(sessionRowHref(session) as never)
      }}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        minHeight: 40,
        paddingHorizontal: 12,
        paddingVertical: 7,
        borderRadius: 12,
        backgroundColor: pressed ? theme.active : theme.hover,
      })}
    >
      <StatusMark mark={mark} size={14} />
      <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
        <AppText
          variant="text-14-medium"
          numberOfLines={1}
          style={{ color: theme.fg, flexShrink: 1 }}
        >
          {title}
        </AppText>
        <AppText
          variant="text-12-regular"
          numberOfLines={1}
          style={{ color: theme.faint, flexShrink: 20, minWidth: 0 }}
        >
          Subagent
        </AppText>
      </View>
      {flag ? (
        <AppText variant="text-12-regular" numberOfLines={1} style={{ color: theme.muted }}>
          {flag}
        </AppText>
      ) : null}
      <ProviderMark providerId={session.providerId} size={12} />
      <CaretRightIcon size={12} color={theme.faint} weight="bold" />
    </Press>
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
