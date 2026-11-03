import * as Haptics from 'expo-haptics'
import { Platform } from 'react-native'

/** A light tick on a tap that changes what is on screen; silent where unsupported. */
export function tap() {
  if (Platform.OS === 'web') return
  Haptics.selectionAsync().catch(() => {
    // Haptics are a nicety; a device without them is fine.
  })
}

/** A success notification: a code was read, a pairing finished. */
export function success() {
  if (Platform.OS === 'web') return
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {
    // Haptics are a nicety; a device without them is fine.
  })
}

/** A warning notification: pairing was refused. */
export function warning() {
  if (Platform.OS === 'web') return
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {
    // Haptics are a nicety; a device without them is fine.
  })
}
