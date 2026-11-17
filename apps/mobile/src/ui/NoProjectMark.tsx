import Svg, { Path } from 'react-native-svg'
import { NO_PROJECT_ICON_DASHES, NO_PROJECT_ICON_PATH } from '@openmanager/app-core/logic'

/**
 * "No project": a chat bubble drawn in dashes, the same shape web draws
 * (app-core `NoProjectIcon`), on Phosphor's 256 grid.
 */
export function NoProjectMark({ size = 12, color }: { size?: number; color: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 256 256" accessible={false}>
      <Path
        d={NO_PROJECT_ICON_PATH}
        fill="none"
        stroke={color}
        strokeWidth={18}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray={NO_PROJECT_ICON_DASHES}
      />
    </Svg>
  )
}
