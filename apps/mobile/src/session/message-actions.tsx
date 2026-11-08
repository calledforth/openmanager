import { createContext, useContext, type ReactNode } from 'react'
import { Pressable, View, type StyleProp, type ViewStyle } from 'react-native'

import type { MessageTarget } from './message-text'

/**
 * A message's long press, the way chat apps do it: it opens the message's
 * actions (copy it whole, or select from it), drawn by the session page over
 * everything. The transcript's own text is not natively selectable: a
 * selection there stops at the edge of a paragraph (each is its own text
 * view), and a long press can only mean one thing.
 */
export interface MessageActions {
  open(target: MessageTarget): void
}

/** The session page's: where a row's long press opens its actions. */
export const MessageActionsContext = createContext<MessageActions | null>(null)

/** One transcript row's: what a long press on its words opens. Stable for the row's life. */
export interface MessageRowActions {
  open(): void
}

export const MessageRowContext = createContext<MessageRowActions | null>(null)

/** The row's actions; null outside a transcript row (a plan in its sheet). */
export const useMessageRow = () => useContext(MessageRowContext)

/** Long enough not to fire as a scroll starts; Android's own long press is 400 ms. */
const LONG_PRESS_MS = 400

/**
 * A message's words, held to open its actions. A plain view outside a
 * transcript row. Not an accessibility element of its own: what it holds
 * (links in a reply, the words) stays reachable as it was.
 */
export function MessageLongPress({
  style,
  children,
}: {
  style?: StyleProp<ViewStyle>
  children: ReactNode
}) {
  const row = useMessageRow()
  if (!row) return <View style={style}>{children}</View>
  return (
    <Pressable
      accessible={false}
      delayLongPress={LONG_PRESS_MS}
      onLongPress={row.open}
      style={style}
    >
      {children}
    </Pressable>
  )
}
