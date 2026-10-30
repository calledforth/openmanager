/** The newest published APK, as CI writes it to the release feed. */
export type UpdateRelease = {
  /** What a person reads, `0.1.14`. */
  version: string
  /** Android's `versionCode`; the one number compared. */
  build: number
  url: string
  /** The APK's size in bytes. */
  size: number
}

/** The feed's answer, or null when it is not one. */
export function parseFeed(raw: unknown): UpdateRelease | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { version, build, url, size } = raw as Record<string, unknown>
  if (typeof version !== 'string' || version.length === 0) return null
  if (typeof build !== 'number' || !Number.isInteger(build)) return null
  if (typeof url !== 'string' || !url.startsWith('https://')) return null
  if (typeof size !== 'number' || size <= 0) return null
  return { version, build, url, size }
}
