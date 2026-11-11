import { Text, View } from 'react-native'
import { snippetRuns, type SearchSnippet } from '@openmanager/app-core/lib/chat-search'

import { AppText } from '../components/ui/AppText'
import type { MessageHitRow as Hit } from '../home/message-search'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { EnvironmentTag, LineDot } from './EnvironmentTag'
import { ProjectChip } from './ProjectChip'
import { rowFill, shortAge } from './SessionRow'
import { StatusMark } from './StatusMark'
import { tap } from './haptics'
import { Press } from './Press'

/**
 * A session at the message that matched: the session row's mark, title and
 * project, then two lines of what was said with the matched words at full
 * strength, and how long ago it was said. "You: " says whose words they
 * are, as a chat list previews its last line. Fills, not borders, as on
 * `SessionRow`: the pressed state is the hover fill, a card at rest its
 * status wash. With `showEnvironment` the project line ends with where it
 * runs.
 */
export function MessageHitRow({
  hit,
  showEnvironment = false,
  onPress,
}: {
  hit: Hit
  showEnvironment?: boolean
  onPress?: () => void
}) {
  const theme = usePhoneTheme()
  const { session, workspace, mark } = hit.row
  const title = session.title?.trim() || 'Untitled session'
  const unsent = Boolean(session.hasUnsentDraft)
  const rest = rowFill(theme, mark, { unsent, settled: !!session.settledAt })
  const environment = showEnvironment ? session.environment : undefined
  const mine = hit.hit.role === 'user'
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${mine ? 'You: ' : ''}${hit.snippet.text}`}
      onPress={() => {
        tap()
        onPress?.()
      }}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 12,
        paddingVertical: 10,
        paddingHorizontal: 12,
        borderRadius: 14,
        marginVertical: 1,
        backgroundColor: pressed ? theme.hover : (rest ?? 'transparent'),
      })}
    >
      <View style={{ width: 22, height: 20, alignItems: 'center', justifyContent: 'center' }}>
        <StatusMark mark={mark} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <AppText
          variant="text-14-medium"
          numberOfLines={1}
          style={{ color: theme.fg, letterSpacing: -0.1, lineHeight: 20 }}
        >
          {title}
        </AppText>
        {workspace || environment ? (
          <View className="mt-0.5 flex-row items-center gap-1.5">
            {workspace ? <ProjectChip name={workspace.name} workspaceId={workspace.path} /> : null}
            {environment ? (
              <>
                {workspace ? <LineDot /> : null}
                <EnvironmentTag environment={environment} />
              </>
            ) : null}
          </View>
        ) : null}
        <AppText
          variant="text-13-regular"
          numberOfLines={2}
          style={{ color: theme.muted, marginTop: 3, lineHeight: 19 }}
        >
          {mine ? <Text style={{ color: theme.faint }}>You: </Text> : null}
          <SnippetText snippet={hit.snippet} color={theme.fg} />
        </AppText>
      </View>
      <View style={{ height: 20, justifyContent: 'center' }}>
        <AppText variant="text-12-regular" style={{ color: theme.faint }}>
          {shortAge(hit.hit.at)}
        </AppText>
      </View>
    </Press>
  )
}

/**
 * The snippet's runs, nested in the line that holds them: the matched ones
 * in the foreground ink at medium weight, the rest in the line's own.
 */
export function SnippetText({ snippet, color }: { snippet: SearchSnippet; color: string }) {
  return (
    <>
      {snippetRuns(snippet.text, snippet.highlights).map((run) =>
        run.match ? (
          <Text
            key={run.start}
            style={{ color, fontFamily: 'Geist-Medium', fontWeight: '500' }}
            testID="snippet-match"
          >
            {run.text}
          </Text>
        ) : (
          <Text key={run.start}>{run.text}</Text>
        ),
      )}
    </>
  )
}
