import AsyncStorage from '@react-native-async-storage/async-storage'
import { useEffect, useState } from 'react'

// Persistent mobile client identity. The desktop worker routes jobs by
// `session.clientId`, falling back to the submitting client's id, so mobile
// needs a stable id to (a) submit jobs and (b) reason about reachability.

const STORAGE_KEY = 'openmanager.mobile.clientId'

function uuidv4(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const random = (Math.random() * 16) | 0
    const value = char === 'x' ? random : (random & 0x3) | 0x8
    return value.toString(16)
  })
}

let cached: string | null = null
let inflight: Promise<string> | null = null

export async function getMobileClientId(): Promise<string> {
  if (cached) return cached
  if (inflight) return inflight

  inflight = (async () => {
    try {
      const stored = await AsyncStorage.getItem(STORAGE_KEY)
      if (stored) {
        cached = stored
        return stored
      }
    } catch {
      // Storage read failed; fall through and mint a fresh id.
    }

    const generated = `mobile-${uuidv4()}`
    try {
      await AsyncStorage.setItem(STORAGE_KEY, generated)
    } catch {
      // Best-effort persistence; still return the generated id for this run.
    }
    cached = generated
    return generated
  })()

  try {
    return await inflight
  } finally {
    inflight = null
  }
}

// Reactive accessor for components/hooks. Resolves to the persisted id on mount.
export function useMobileClientId(): string | null {
  const [clientId, setClientId] = useState<string | null>(cached)

  useEffect(() => {
    if (clientId) return
    let active = true
    getMobileClientId()
      .then((id) => {
        if (active) setClientId(id)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [clientId])

  return clientId
}
