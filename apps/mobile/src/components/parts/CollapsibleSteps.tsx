import { useState, type ReactNode } from 'react'
import { TouchableOpacity, View } from 'react-native'

import { AppText } from '../ui/AppText'

// Mirror of the desktop `CollapsibleSteps`: a "Worked N steps" summary that
// hides the intermediate tool/reasoning trail behind a tap once a final answer
// has arrived.

export function CollapsibleSteps({
  stepsCount,
  children,
  defaultExpanded = false,
}: {
  stepsCount: number
  children: ReactNode
  defaultExpanded?: boolean
}) {
  const [expanded, setExpanded] = useState(defaultExpanded)

  if (stepsCount === 0) return null

  return (
    <View className="py-px">
      <TouchableOpacity
        activeOpacity={0.7}
        onPress={() => setExpanded((prev) => !prev)}
        hitSlop={6}
        className="flex-row items-center gap-1"
      >
        <AppText variant="text-14-regular" className="text-textMuted">
          Worked
        </AppText>
        <AppText variant="text-14-regular" className="text-textFaint">
          {stepsCount} step{stepsCount !== 1 ? 's' : ''}
        </AppText>
      </TouchableOpacity>
      {expanded ? <View className="mt-0.5">{children}</View> : null}
    </View>
  )
}
