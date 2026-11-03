/**
 * `app.json`, plus what only a published build knows. CI sets these for the
 * builds it releases (docs/RELEASING.md); a local build sets neither.
 *
 * - `OPENMANAGER_BUILD_NUMBER`: the release's build number. It becomes Android's
 *   `versionCode`, which is what makes one APK newer than another, and the last
 *   part of the version a person reads.
 * - `EXPO_PUBLIC_DISTRIBUTION=github`: this APK updates itself from GitHub
 *   Releases, so it may ask Android to install one. Any other build (a local
 *   one, a future Play build) leaves the permission out: Play refuses an app
 *   that installs its own updates. The app reads the same variable, see
 *   `src/updates/distribution.ts`.
 */
module.exports = ({ config }) => {
  const build = process.env.OPENMANAGER_BUILD_NUMBER
  const selfUpdating = process.env.EXPO_PUBLIC_DISTRIBUTION === 'github'
  return {
    ...config,
    ...(build ? { version: config.version.replace(/\d+$/, build) } : {}),
    android: {
      ...config.android,
      ...(build ? { versionCode: Number(build) } : {}),
      ...(selfUpdating ? { permissions: ['android.permission.REQUEST_INSTALL_PACKAGES'] } : {}),
    },
  }
}
