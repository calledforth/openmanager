import { View } from 'react-native'

import { useTokens } from '../../theme/useTokens'
import { AppText } from '../ui/AppText'
import { ShimmerText } from '../chat/ShimmerText'
import { getToolIcon } from './toolIcons'

interface ToolPartData {
  type: 'tool'
  id: string
  /** What the environment calls the call (its title, else its kind). */
  tool?: string
  /** The protocol's tool kind: read, edit, execute, search, fetch… */
  kind?: string
  state?: { status?: string }
}

/** A tool's status as the row says it; running shimmers instead. */
function statusWord(status: string | undefined): string | null {
  switch (status) {
    case 'error':
      return 'failed'
    case 'pending':
      return 'waiting'
    default:
      return null
  }
}

/**
 * A bare tool row: the tool's icon, its name and its status, as the
 * environment reports them. Inputs, output and diffs come with the rich tool
 * rows later; nothing here expands.
 */
export function ToolRow({ part }: { part: ToolPartData }) {
  const tokens = useTokens()
  const status = part.state?.status
  const running = status === 'running'
  const failed = status === 'error'
  const Icon = getToolIcon(part.tool ?? '', part.kind)
  const name = part.tool?.trim() || part.kind || 'Tool'
  const word = statusWord(status)
  return (
    <View className="flex-row items-center gap-1.5 py-px">
      <Icon
        size={13}
        color={failed ? tokens.destructive : running ? tokens.textMuted : tokens.textFaint}
      />
      {running ? (
        <ShimmerText variant="text-14-regular" className="flex-1">
          {name}
        </ShimmerText>
      ) : (
        <AppText
          variant="text-14-regular"
          numberOfLines={1}
          className={`flex-1 ${failed ? 'text-destructive' : 'text-textMuted'}`}
        >
          {name}
          {word ? (
            <AppText
              variant="text-14-regular"
              className={failed ? 'text-destructive' : 'text-textFaint'}
            >
              {' '}
              {word}
            </AppText>
          ) : null}
        </AppText>
      )}
    </View>
  )
}
