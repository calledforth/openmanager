import * as Haptics from 'expo-haptics'
import { Platform } from 'react-native'

/** A light tick on a tap that changes what is on screen; silent where unsupported. */
export function tap() {
  if (Platform.OS === 'web') return
  Haptics.selectionAsync().catch(() => {
    // Haptics are a nicety; a device without them is fine.
  })
}
