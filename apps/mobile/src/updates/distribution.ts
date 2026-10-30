import { Platform } from 'react-native'

/**
 * Only the APKs CI publishes to GitHub Releases update themselves. Every other
 * build (a local one, a future Play build, iOS) has no updater and shows
 * nothing of it. `app.config.js` reads the same variable for the Android
 * permission.
 */
export const SELF_UPDATING =
  Platform.OS === 'android' && process.env.EXPO_PUBLIC_DISTRIBUTION === 'github'

/** A fixed address CI rewrites on every release; see docs/RELEASING.md. */
export const UPDATE_FEED_URL =
  process.env.EXPO_PUBLIC_UPDATE_FEED_URL ??
  'https://github.com/calledforth/openmanager/releases/download/mobile-latest/latest.json'
