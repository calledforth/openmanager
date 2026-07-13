import type { RuntimeConfig } from '../shared/runtime-config'

function isLocalHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

export function normalizeConvexUrl(rawValue: string, allowHttpLocalhost: boolean): string {
  const value = rawValue.trim()
  if (!value) throw new Error('Enter a Convex deployment URL.')

  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Enter a complete URL, such as https://deployment.convex.cloud.')
  }

  const isLocalHttp =
    allowHttpLocalhost && url.protocol === 'http:' && isLocalHostname(url.hostname)
  if (url.protocol !== 'https:' && !isLocalHttp) {
    throw new Error('Convex deployment URLs must use HTTPS.')
  }
  if (url.username || url.password) throw new Error('Credentials are not allowed in the URL.')
  if (url.search || url.hash) throw new Error('Remove query parameters and fragments from the URL.')
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error('Use the deployment origin without an additional path.')
  }

  return url.origin
}

function tryNormalize(value: string, allowHttpLocalhost: boolean): string {
  if (!value.trim()) return ''
  try {
    return normalizeConvexUrl(value, allowHttpLocalhost)
  } catch {
    return ''
  }
}

export function resolveRuntimeConfig(
  settingsUrl: string,
  environmentUrl: string,
  allowHttpLocalhost: boolean,
): RuntimeConfig {
  const normalizedSettingsUrl = tryNormalize(settingsUrl, allowHttpLocalhost)
  const normalizedEnvironmentUrl = tryNormalize(environmentUrl, allowHttpLocalhost)

  if (normalizedSettingsUrl) {
    return {
      convexUrl: normalizedSettingsUrl,
      convexSource: 'settings',
      environmentUrlAvailable: Boolean(normalizedEnvironmentUrl),
    }
  }

  if (normalizedEnvironmentUrl) {
    return {
      convexUrl: normalizedEnvironmentUrl,
      convexSource: 'environment',
      environmentUrlAvailable: true,
    }
  }

  return {
    convexUrl: '',
    convexSource: 'unset',
    environmentUrlAvailable: false,
  }
}
