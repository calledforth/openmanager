import { CLIENT_LABEL_MAX_LENGTH, ClientLabelSchema } from '@openmanager/protocol'

/** What `expo-device` says about the phone; any of it may be missing. */
export type DeviceFacts = {
  modelName?: string | null
  osName?: string | null
}

const FALLBACK = 'Phone'

/**
 * The name the phone suggests for itself on the environment's Devices list:
 * its model ("Pixel 9", "iPhone 16 Pro"), else its system ("Android"), else
 * "Phone". The person can change it before pairing. A link made with a name
 * of its own keeps that name instead (the environment decides).
 */
export function suggestPhoneLabel(facts: DeviceFacts): string {
  for (const candidate of [facts.modelName, facts.osName]) {
    const parsed = ClientLabelSchema.safeParse(candidate ?? '')
    if (parsed.success) return parsed.data.slice(0, CLIENT_LABEL_MAX_LENGTH)
  }
  return FALLBACK
}

/**
 * The label to send with the exchange: the trimmed name, `undefined` when it
 * is empty (the environment names the device itself), or the problem with it.
 */
export function readPhoneLabel(
  input: string,
): { ok: true; label: string | undefined } | { ok: false; problem: string } {
  if (input.trim() === '') return { ok: true, label: undefined }
  const parsed = ClientLabelSchema.safeParse(input)
  if (parsed.success) return { ok: true, label: parsed.data }
  return { ok: false, problem: parsed.error.issues[0]?.message ?? 'That name cannot be used.' }
}
