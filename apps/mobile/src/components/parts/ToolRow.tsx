import { memo } from 'react'
import { View } from 'react-native'

import { usePhoneTheme } from '../../theme/ThemeProvider'
import { StatusMark } from '../../ui/StatusMark'
import { AppText } from '../ui/AppText'
import { getToolIcon } from './toolIcons'

export interface ToolPartData {
  type: 'tool'
  id: string
  /** What the environment calls the call (its title, else its kind). */
  tool?: string
  /** The protocol's tool kind: read, edit, execute, search, fetch… */
  kind?: string
  state?: { status?: string }
}

/**
 * A bare tool row: the tool's glyph, the provider's own name for the call,
 * and its status on the right (a turning ring while it runs, a dot once it
 * is done, red when it failed), as the environment reports them. Inputs,
 * output and diffs come with the rich tool rows later; nothing here expands.
 */
export const ToolRow = memo(function ToolRow({ part }: { part: ToolPartData }) {
  const theme = usePhoneTheme()
  const status = part.state?.status
  const running = status === 'running'
  const failed = status === 'error'
  const waiting = status === 'pending'
  const Icon = getToolIcon(part.tool ?? '', part.kind)
  const name = part.tool?.trim() || part.kind || 'Tool'
  return (
    <View
      accessibilityLabel={`${name}${failed ? ', failed' : running ? ', running' : waiting ? ', waiting' : ''}`}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 20 }}
    >
      <Icon size={13} color={failed ? theme.status.error : theme.faint} />
      <AppText
        variant="text-13-medium"
        numberOfLines={1}
        style={{ flex: 1, color: failed ? theme.status.error : theme.fg }}
      >
        {name}
      </AppText>
      {running ? (
        <StatusMark mark="working" size={11} />
      ) : failed ? (
        <AppText variant="text-12-regular" style={{ color: theme.status.error }}>
          failed
        </AppText>
      ) : waiting ? (
        <AppText variant="text-12-regular" style={{ color: theme.faint }}>
          waiting
        </AppText>
      ) : status === 'completed' ? (
        <View
          style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: theme.status.done }}
        />
      ) : null}
    </View>
  )
})
