import { Alert, Platform } from 'react-native'

// Web-safe wrappers around the native Alert API. `Alert.alert` is a silent
// no-op under react-native-web, so on the web we fall back to the browser's
// window.alert / window.confirm dialogs.

export function showAlert(title: string, message?: string) {
  if (Platform.OS === 'web') {
    window.alert(message ? `${title}\n${message}` : title)
    return
  }
  Alert.alert(title, message)
}

export function confirmDestructive(opts: {
  title: string
  message?: string
  confirmLabel: string
  onConfirm: () => void
}) {
  const { title, message, confirmLabel, onConfirm } = opts

  if (Platform.OS === 'web') {
    if (window.confirm(message ? `${title}\n${message}` : title)) onConfirm()
    return
  }

  Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel' },
    { text: confirmLabel, style: 'destructive', onPress: onConfirm },
  ])
}

// Native two-step action sheet (e.g. long-press / overflow menus). On the web
// there is no action-sheet primitive, so the single destructive action fires
// directly — callers pair this with confirmDestructive for the second step.
export function showDestructiveActionSheet(opts: {
  title: string
  actionLabel: string
  onSelect: () => void
}) {
  const { title, actionLabel, onSelect } = opts

  if (Platform.OS === 'web') {
    onSelect()
    return
  }

  Alert.alert(title, undefined, [
    { text: actionLabel, style: 'destructive', onPress: onSelect },
    { text: 'Cancel', style: 'cancel' },
  ])
}
