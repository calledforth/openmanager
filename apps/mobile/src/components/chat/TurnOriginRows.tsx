import {
  ArrowBendDownRightIcon,
  ArrowsInLineVerticalIcon,
  FlowArrowIcon,
  MagnifyingGlassIcon,
} from 'phosphor-react-native'
import { createContext, memo, useContext, useRef, useState } from 'react'
import { ScrollView, View } from 'react-native'
import Animated from 'react-native-reanimated'
import { operationPromptView, providerName, subagentsNoticeLine } from '@openmanager/app-core/logic'

import { usePhoneTheme } from '../../theme/ThemeProvider'
import { tap } from '../../ui/haptics'
import { Press } from '../../ui/Press'
import { ProviderMark } from '../../ui/ProviderMark'
import { DisclosureChevron, revealBody } from '../parts/Disclosure'
import { TextPart } from '../parts/TextPart'
import { AppText } from '../ui/AppText'

// The phone's copies of web's `TurnOriginRows` (app-core components/chat):
// the user rows nobody typed as a prompt read as what they are, not as a
// bubble on the right. The words are shared (`subagentsNoticeLine`,
// `operationPromptView`).

/** Who handed a subagent its work: the parent session's agent. */
export interface DelegatingAgent {
  providerId: string
  /** The parent session's title, when it has one. */
  sessionTitle?: string
  /** Open the parent session. Absent when the page cannot. */
  onOpen?: () => void
}

/** The parent of the session on the page, when it is a child session. */
export const DelegatingAgentContext = createContext<DelegatingAgent | null>(null)

/** Past this many characters a brief starts folded; the parent's briefs run long. */
const FOLD_AT = 600
/** How much of a folded brief shows. */
const FOLDED_HEIGHT = 152

/**
 * The prompt a parent agent gave its subagent, at the top of the child's
 * turn: a caption saying who asked, over the brief on a quiet fill, folded
 * when long. A tap on the parent's title opens it.
 */
export const DelegatedPrompt = memo(function DelegatedPrompt({ content }: { content: string }) {
  const theme = usePhoneTheme()
  const from = useContext(DelegatingAgentContext)
  const long = content.length > FOLD_AT
  const [open, setOpen] = useState(!long)
  const name = from ? providerName(from.providerId) : 'the parent agent'
  return (
    <View style={{ gap: 6, paddingTop: 8 }}>
      <View
        style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 2 }}
        accessibilityLabel={`Prompt from ${name}${from?.sessionTitle ? `, ${from.sessionTitle}` : ''}`}
      >
        {from ? (
          <ProviderMark providerId={from.providerId} size={12} />
        ) : (
          <ArrowBendDownRightIcon size={12} color={theme.faint} />
        )}
        <AppText variant="text-12-regular" style={{ color: theme.muted, flexShrink: 0 }}>
          {`Prompt from ${name}`}
        </AppText>
        {from?.sessionTitle ? (
          <>
            <AppText variant="text-12-regular" style={{ color: theme.faint }}>
              ·
            </AppText>
            {from.onOpen ? (
              <Press
                accessibilityRole="link"
                accessibilityLabel={`Open ${from.sessionTitle}`}
                hitSlop={8}
                onPress={() => {
                  tap()
                  from.onOpen!()
                }}
                style={({ pressed }) => ({ flexShrink: 1, opacity: pressed ? 0.6 : 1 })}
              >
                <AppText
                  variant="text-12-regular"
                  numberOfLines={1}
                  style={{ color: theme.faint, textDecorationLine: 'underline' }}
                >
                  {from.sessionTitle}
                </AppText>
              </Press>
            ) : (
              <AppText
                variant="text-12-regular"
                numberOfLines={1}
                style={{ color: theme.faint, flexShrink: 1 }}
              >
                {from.sessionTitle}
              </AppText>
            )}
          </>
        ) : null}
      </View>
      <View
        style={{
          borderRadius: 12,
          backgroundColor: theme.hover,
          paddingHorizontal: 14,
          paddingVertical: 10,
        }}
      >
        <View style={open ? undefined : { maxHeight: FOLDED_HEIGHT, overflow: 'hidden' }}>
          <TextPart text={content} live={false} />
        </View>
        {long ? (
          <Press
            accessibilityRole="button"
            accessibilityState={{ expanded: open }}
            hitSlop={8}
            onPress={() => setOpen((value) => !value)}
            style={({ pressed }) => ({ marginTop: 6, opacity: pressed ? 0.6 : 1 })}
          >
            <AppText variant="text-12-regular" style={{ color: theme.faint }}>
              {open ? 'Show less' : 'Show the whole prompt'}
            </AppText>
          </Press>
        ) : null}
      </View>
    </View>
  )
})

/** How tall the notice's words may grow before they scroll on their own. */
const NOTICE_MAX_HEIGHT = 320

/**
 * The environment telling the agent its subagents finished. Nobody typed it,
 * so it reads as an event in the timeline: one quiet line, which opens on a
 * tap to what the agent was told.
 */
export const SubagentsFinishedNotice = memo(function SubagentsFinishedNotice({
  content,
}: {
  content: string
}) {
  const theme = usePhoneTheme()
  const [open, setOpen] = useState(false)
  const revealedRef = useRef(false)
  const { title, more } = subagentsNoticeLine(content)
  const line = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 20 }}>
      <FlowArrowIcon size={13} color={theme.status.done} />
      <AppText
        variant="text-13-regular"
        numberOfLines={1}
        style={{ color: theme.muted, flexShrink: 1 }}
      >
        {title}
      </AppText>
      {more ? <DisclosureChevron open={open} color={theme.faint} size={10} /> : null}
    </View>
  )
  return (
    <View style={{ paddingTop: 8 }}>
      {more ? (
        <Press
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          accessibilityLabel={title}
          hitSlop={4}
          onPress={() => {
            revealedRef.current = true
            setOpen((value) => !value)
          }}
          style={({ pressed }) => ({ alignSelf: 'flex-start', opacity: pressed ? 0.7 : 1 })}
        >
          {line}
        </Press>
      ) : (
        <View accessibilityLabel={title}>{line}</View>
      )}
      {open ? (
        <Animated.View
          entering={revealedRef.current ? revealBody : undefined}
          style={{
            marginTop: 6,
            borderRadius: 10,
            backgroundColor: theme.hover,
            paddingHorizontal: 12,
            paddingVertical: 8,
            maxHeight: NOTICE_MAX_HEIGHT,
          }}
        >
          <ScrollView nestedScrollEnabled showsVerticalScrollIndicator={false}>
            <AppText variant="text-12-regular" selectable style={{ color: theme.muted }}>
              {content}
            </AppText>
          </ScrollView>
        </Animated.View>
      ) : null}
    </View>
  )
})

/**
 * The command that ran a provider operation (`/review`, `/compact`): a person
 * sent it, but as an instruction to the provider, not words for the agent. So
 * it opens its turn as one line saying what ran, with the command as typed at
 * its end, rather than as a bubble.
 */
export const OperationPrompt = memo(function OperationPrompt({
  content,
  origin,
}: {
  content: string
  origin: 'review' | 'compact'
}) {
  const theme = usePhoneTheme()
  const { label, detail, command } = operationPromptView(content, origin)
  const Glyph = origin === 'review' ? MagnifyingGlassIcon : ArrowsInLineVerticalIcon
  return (
    <View
      accessibilityLabel={`${label}${detail ? `, ${detail}` : ''}`}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 8, minHeight: 28 }}
      testID={`turn-origin:${origin}`}
    >
      <Glyph size={14} color={theme.faint} />
      <AppText variant="text-14-regular" style={{ color: theme.fg, flexShrink: 0 }}>
        {label}
      </AppText>
      {detail ? (
        <AppText
          variant="text-14-regular"
          numberOfLines={1}
          style={{ color: theme.muted, flexShrink: 1 }}
        >
          {detail}
        </AppText>
      ) : null}
      <View
        style={{
          marginLeft: 'auto',
          borderRadius: 6,
          backgroundColor: theme.hover,
          paddingHorizontal: 6,
          paddingVertical: 2,
        }}
      >
        <AppText variant="mono" style={{ color: theme.faint, fontSize: 12 }}>
          {command}
        </AppText>
      </View>
    </View>
  )
})
