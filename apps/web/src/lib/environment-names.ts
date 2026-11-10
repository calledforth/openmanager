import { environmentPlatformName } from '@openmanager/protocol'
import type { StoredEnvironment } from '@openmanager/environment-client/connection'

function nameKey(label: string) {
  return label.trim().toLocaleLowerCase()
}

/**
 * The saved environments with the names people should read. An environment
 * keeps the name its server gave it, unless another saved environment has the
 * same one: then its platform follows in brackets, "Laptop (WSL)" beside
 * "Laptop (Windows)". That is the usual twin, as a WSL distro reports the
 * hostname of the Windows machine it runs on.
 *
 * Places that show the platform's logo beside the name take the brackets back
 * off (`nameWithoutPlatform`); the full name stays for text and screen readers.
 *
 * Only for showing: the stored label stays the server's, so a name that stops
 * being shared reads plain again. Two twins on the same platform still read
 * alike, and the lists that must tell them apart add the address.
 *
 * Returns `environments` itself when nothing changes, and every record that
 * keeps its name as it was, so memoised readers see no change.
 */
export function withDisplayLabels<T extends Pick<StoredEnvironment, 'label' | 'platform'>>(
  environments: T[],
): T[] {
  const counts = new Map<string, number>()
  for (const { label } of environments) {
    const key = nameKey(label)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  let changed = false
  const named = environments.map((environment) => {
    const platform = environmentPlatformName(environment.platform)
    if (!platform || (counts.get(nameKey(environment.label)) ?? 0) < 2) return environment
    changed = true
    return { ...environment, label: `${environment.label} (${platform})` }
  })
  return changed ? named : environments
}
