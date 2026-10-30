import Constants from 'expo-constants'
import { Directory, File, Paths } from 'expo-file-system'
import { startActivityAsync } from 'expo-intent-launcher'

import { UPDATE_FEED_URL } from './distribution'
import type { UpdateRelease } from './feed'
import type { UpdaterPorts } from './updater'

const FEED_TIMEOUT_MS = 15_000
const APK_TYPE = 'application/vnd.android.package-archive'
/** `Intent.FLAG_GRANT_READ_URI_PERMISSION`: lets the installer read our file. */
const GRANT_READ = 1

const downloads = () => new Directory(Paths.cache, 'updates')

/** An APK left from an earlier run is either installed already or stale. */
export function clearDownloads() {
  const folder = downloads()
  if (folder.exists) folder.delete()
}

async function fetchFeed(): Promise<unknown> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), FEED_TIMEOUT_MS)
  try {
    const response = await fetch(`${UPDATE_FEED_URL}?t=${Date.now()}`, {
      headers: { accept: 'application/json' },
      signal: abort.signal,
    })
    if (!response.ok) throw new Error(`The update feed answered ${response.status}.`)
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

async function download(
  release: UpdateRelease,
  onProgress: (fraction: number | null) => void,
): Promise<string> {
  clearDownloads()
  const folder = downloads()
  folder.create({ intermediates: true })
  const file = await File.downloadFileAsync(
    release.url,
    new File(folder, `openmanager-${release.version}.apk`),
    {
      onProgress: ({ bytesWritten, totalBytes }) =>
        onProgress(totalBytes > 0 ? bytesWritten / totalBytes : null),
    },
  )
  // A cut-off transfer can end cleanly; Android would only call it corrupt.
  if (file.size !== release.size) {
    file.delete()
    throw new Error('The download is incomplete.')
  }
  return file.contentUri
}

async function install(apk: string) {
  await startActivityAsync('android.intent.action.VIEW', {
    data: apk,
    type: APK_TYPE,
    flags: GRANT_READ,
  })
}

export const nativePorts: UpdaterPorts = {
  currentBuild: Constants.expoConfig?.android?.versionCode ?? 0,
  fetchFeed,
  download,
  install,
  now: Date.now,
}
