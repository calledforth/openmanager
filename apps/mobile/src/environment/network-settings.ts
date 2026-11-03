/** Android's wireless settings: airplane mode, Wi-Fi, mobile data. */
export const ANDROID_WIRELESS_SETTINGS = 'android.settings.WIRELESS_SETTINGS'

/** The part of React Native's `Linking` this needs. */
export type SettingsLinking = {
  sendIntent(action: string): Promise<void>
  openSettings(): Promise<void>
}

/**
 * Open the phone's network settings for the offline state's next step.
 * Android goes to its wireless settings; where that screen is missing, and on
 * iOS (which lets an app open only its own page), the app's settings. Every
 * failure is caught here: `false` when nothing could be opened, so the screen
 * can say so instead of the tap doing nothing.
 */
export async function openNetworkSettings(
  platform: string,
  linking: SettingsLinking,
): Promise<boolean> {
  if (platform === 'android') {
    try {
      await linking.sendIntent(ANDROID_WIRELESS_SETTINGS)
      return true
    } catch {
      // No such screen on this build of Android: the app's settings instead.
    }
  }
  try {
    await linking.openSettings()
    return true
  } catch {
    return false
  }
}

/** What the offline panel says when no settings screen would open. */
export const NETWORK_SETTINGS_FAILED =
  "Couldn't open the settings. Turn off airplane mode or turn on Wi-Fi from the phone's quick settings."
