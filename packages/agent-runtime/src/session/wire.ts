import * as acp from '@agentclientprotocol/sdk'
import type {
  AgentEvent,
  AgentInfo,
  AuthMethod,
  ContentBlock,
  ModeListing,
  ModelListing,
  ProviderSessionInfo,
  SessionConfigOption,
  ToolCallContent,
} from '@agentpack/contract'
import type { BackendEvent, BackendRoute } from '../backends/Backend.js'
import { RpcTimeoutError } from './timeout.js'

/** Wire-normalisation helpers lifted verbatim from `AcpBackend`. They are
 * shared by the session runtime and the throwaway probe runtime, which is the
 * only reason they moved out of the backend file. Nothing here was redesigned. */

export type RecordValue = Record<string, unknown>

export const object = (value: unknown): RecordValue =>
  value && typeof value === 'object' ? (value as RecordValue) : {}
export const string = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined
export const number = (value: unknown): number | undefined =>
  typeof value === 'number' ? value : undefined

export const sessionIdOf = (value: unknown): string | undefined => {
  const p = object(value)
  return (
    string(p.sessionId) ??
    string(object(p._meta).sessionId) ??
    string(object(p.toolCall).sessionId) ??
    string(object(p.update).sessionId)
  )
}

export const errorCode = (error: unknown): number | undefined => number(object(error).code)
export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : 'ACP operation failed'
export const isAuthRequired = (error: unknown): boolean => errorCode(error) === -32002

/** How agents say "I have never heard of that session id". ACP reserves no
 * code for it, so the message is the only signal there is. */
const SESSION_NOT_FOUND = [/session not found/i, /unknown session/i, /no such session/i]

/** Whether a `session/load` failure means the session genuinely does not
 * exist — the created-but-never-prompted case, which legitimately falls back
 * to `session/new`.
 *
 * Deliberately a whitelist rather than "anything that is not X". The two ways
 * of being wrong are not symmetric: mistaking a timeout or a transport error
 * for "not found" opens a second session while the first load may still be
 * running and loses the user's transcript, whereas mistaking a genuine
 * not-found for something worse only fails a start that the next use retries.
 * An unanswered request is never a not-found: it is not an answer at all. */
export function isSessionNotFound(error: unknown): boolean {
  if (error instanceof RpcTimeoutError) return false
  const message = errorMessage(error)
  return SESSION_NOT_FOUND.some((pattern) => pattern.test(message))
}

export const ACP_ELICITATION_METHOD = acp.methods.client.elicitation.create
/** Plans deserve a longer review window than the default extension timeout. */
export const PLAN_REVIEW_TIMEOUT_MS = 30 * 60 * 1000

/** Client capabilities sent on `initialize`. Identical for session and probe
 * processes so an agent cannot behave differently between the two. */
export function initializeRequest() {
  return {
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
      elicitation: { form: {} },
      _meta: { parameterizedModelPicker: true },
    },
    clientInfo: { name: '@agentpack/runtime', version: '0.1.0' },
  }
}

export type SessionInitialState = {
  models?: ModelListing
  modes?: ModeListing
  configOptions: SessionConfigOption[]
}

export function normalizeModelListing(value: unknown): ModelListing {
  const listing = object(value)
  const availableModels = Array.isArray(listing.availableModels)
    ? listing.availableModels.flatMap((value) => {
        const model = object(value)
        const id = string(model.modelId) ?? string(model.id)
        if (!id) return []
        return [
          {
            id,
            displayName: string(model.name) ?? string(model.displayName) ?? id,
            ...(string(model.description) !== undefined
              ? { description: string(model.description) }
              : {}),
          },
        ]
      })
    : undefined

  return {
    ...(string(listing.currentModelId) !== undefined
      ? { currentModelId: string(listing.currentModelId) }
      : {}),
    ...(availableModels !== undefined ? { availableModels } : {}),
  }
}

export function normalizeModeListing(value: unknown): ModeListing {
  const listing = object(value)
  const availableModes = Array.isArray(listing.availableModes)
    ? listing.availableModes.flatMap((value) => {
        const mode = object(value)
        const id = string(mode.id)
        if (!id) return []
        return [
          {
            id,
            displayName: string(mode.name) ?? string(mode.displayName) ?? id,
            ...(string(mode.description) !== undefined
              ? { description: string(mode.description) }
              : {}),
          },
        ]
      })
    : undefined

  return {
    ...(string(listing.currentModeId) !== undefined
      ? { currentModeId: string(listing.currentModeId) }
      : {}),
    ...(availableModes !== undefined ? { availableModes } : {}),
  }
}

/** A model's own config controls, folded into the flags the composer gates on.
 *
 * Effort and fast mode reach us two different ways depending on the provider.
 * Claude reports them as fields on the model row, which `claude-catalog` maps
 * straight across. Cursor reports them as a *select* and a *boolean* in the
 * model's `configOptions` — the same shape a live session publishes — so the
 * catalog path has to derive the flags rather than read them.
 *
 * Matching is by `category` first and name only as a fallback, in that order
 * for a reason: `category` is the agent stating what a control means, while
 * the name is a human label that a rewording would silently break. The name
 * patterns exist because Cursor's own bridge leaves `category` unset on some
 * builds, which is exactly the case this whole path is trying to survive. */
function modelCapabilitiesFromConfig(options: readonly SessionConfigOption[]): {
  effortLevels?: string[]
  supportsFastMode?: boolean
} {
  const effort = options.find(
    (option) =>
      option.type === 'select' &&
      (option.category === 'effort' ||
        option.category === 'thought_level' ||
        (option.category === undefined && /\b(effort|reasoning|thinking)\b/i.test(option.name))),
  )
  const fast = options.find(
    (option) =>
      option.type === 'boolean' &&
      (option.category === 'fast_mode' ||
        (option.category === undefined && /\bfast\b/i.test(option.name))),
  )
  // An effort control with no values is not an effort control: offering the
  // pill with an empty menu is worse than hiding it.
  const levels =
    effort?.type === 'select' ? effort.options.map((value) => value.value).filter(Boolean) : []
  return {
    ...(levels.length > 0 ? { effortLevels: levels } : {}),
    ...(fast ? { supportsFastMode: true } : {}),
  }
}

/** The response to a provider's unattached catalog method (Cursor's
 * `cursor/list_available_models`).
 *
 * Deliberately separate from `normalizeModelListing`: that one reads the
 * `models` block of a *session* response, where the catalog is flat and the
 * capabilities live on the session's own `configOptions`. Here every model
 * carries its own `configOptions`, which is the entire reason the method is
 * worth calling — it is the only way to learn what effort levels a model the
 * user has never selected accepts.
 *
 * Tolerant about naming because this is a vendor extension outside the ACP
 * schema, so nothing validates it for us and a rename would otherwise empty
 * the picker with no error to show. `slug` is what Cursor sends today; `id`
 * and `modelId` are accepted so a rename does not become an outage. */
export function normalizeCatalogListing(value: unknown): ModelListing {
  const response = object(value)
  const rows = Array.isArray(response.models)
    ? response.models
    : Array.isArray(response.availableModels)
      ? response.availableModels
      : []
  let currentModelId: string | undefined
  const availableModels = rows.flatMap((row) => {
    const model = object(row)
    const id = string(model.slug) ?? string(model.modelId) ?? string(model.id)
    if (!id) return []
    if (model.isDefault === true && currentModelId === undefined) currentModelId = id
    const configOptions = Array.isArray(model.configOptions)
      ? (model.configOptions as SessionConfigOption[])
      : []
    return [
      {
        id,
        displayName: string(model.name) ?? string(model.displayName) ?? id,
        ...(string(model.description) !== undefined
          ? { description: string(model.description) }
          : {}),
        ...(number(model.contextWindowTokens) !== undefined
          ? { contextWindowTokens: number(model.contextWindowTokens) }
          : {}),
        ...modelCapabilitiesFromConfig(configOptions),
      },
    ]
  })
  // No rows is not a catalog. Returning `{}` rather than `{availableModels: []}`
  // is what lets every caller downstream tell "the method answered nothing"
  // from "this agent genuinely has no models", which the retain-on-empty rules
  // depend on.
  if (availableModels.length === 0) return {}
  return {
    availableModels,
    ...(currentModelId !== undefined
      ? { currentModelId }
      : string(response.currentModelId) !== undefined
        ? { currentModelId: string(response.currentModelId) }
        : {}),
  }
}

export function modelListingFromConfig(
  options: readonly SessionConfigOption[],
): ModelListing | undefined {
  const control = options.find(
    (option) =>
      option.type === 'select' &&
      (option.category === 'model' ||
        (option.category === undefined && /\bmodel\b/i.test(option.name))),
  )
  if (!control || control.type !== 'select') return undefined
  return {
    currentModelId: control.currentValue,
    availableModels: control.options.map((option) => ({
      id: option.value,
      displayName: option.name,
      ...(option.description ? { description: option.description } : {}),
    })),
  }
}

export function modeListingFromConfig(
  options: readonly SessionConfigOption[],
): ModeListing | undefined {
  const control = options.find(
    (option) =>
      option.type === 'select' &&
      (option.category === 'mode' ||
        (option.category === undefined && /\bmode\b/i.test(option.name))),
  )
  if (!control || control.type !== 'select') return undefined
  return {
    currentModeId: control.currentValue,
    availableModes: control.options.map((option) => ({
      id: option.value,
      displayName: option.name,
      ...(option.description ? { description: option.description } : {}),
    })),
  }
}

export function initialState(response: RecordValue): SessionInitialState {
  const configOptions = Array.isArray(response.configOptions)
    ? (response.configOptions as SessionConfigOption[])
    : []
  const directModels = normalizeModelListing(response.models)
  const directModes = normalizeModeListing(response.modes)
  return {
    models:
      directModels.currentModelId || directModels.availableModels
        ? directModels
        : modelListingFromConfig(configOptions),
    modes:
      directModes.currentModeId || directModes.availableModes
        ? directModes
        : modeListingFromConfig(configOptions),
    configOptions,
  }
}

export function contentBlock(value: unknown): ContentBlock {
  const v = object(value)
  const type = string(v.type)
  if (type === 'text') return { type, text: string(v.text) ?? '' }
  if (type === 'image' || type === 'audio')
    return {
      type,
      mimeType: string(v.mimeType) ?? 'application/octet-stream',
      data: string(v.data) ?? '',
    }
  if (type === 'resource_link')
    return { type, uri: string(v.uri) ?? '', name: string(v.name), mimeType: string(v.mimeType) }
  if (type === 'resource')
    return {
      type,
      uri: string(v.uri),
      mimeType: string(v.mimeType),
      text: string(v.text),
      data: string(v.data),
    }
  return { type: 'text', text: string(v.text) ?? '' }
}

export function toolContent(value: unknown): ToolCallContent {
  const v = object(value)
  const type = string(v.type)
  if (type === 'diff')
    return {
      type,
      path: string(v.path) ?? '',
      oldText: string(v.oldText) ?? null,
      newText: string(v.newText) ?? '',
    }
  if (type === 'terminal') return { type, terminalId: string(v.terminalId) ?? '' }
  return { type: 'content', content: contentBlock(v.content) }
}

export function routeEvent(
  route: BackendRoute,
  sessionId: string | undefined,
  category: AgentEvent['category'],
  event: AgentEvent['event'],
  data: unknown,
): BackendEvent {
  return { ...route, sessionId, category, event, data } as BackendEvent
}

/** The `authMethods` array of an `initialize` response, normalized. */
export function authMethods(response: RecordValue): AuthMethod[] {
  if (!Array.isArray(response.authMethods)) return []
  return response.authMethods
    .map((v): AuthMethod => {
      const m = object(v)
      return {
        id: string(m.id) ?? string(m.methodId) ?? '',
        displayName: string(m.name) ?? string(m.displayName) ?? string(m.id) ?? 'Authentication',
        description: string(m.description),
      }
    })
    .filter((m) => m.id)
}

export function agentInfo(response: RecordValue): AgentInfo | undefined {
  const raw = object(response.agentInfo)
  const name = string(raw.name)
  return name ? { name, version: string(raw.version) } : undefined
}

/** True when the agent advertised `sessionCapabilities.list` *and* the provider
 * config allows it. Cursor advertises it as `{}`, which is neither undefined
 * nor false. */
export function sessionListAdvertised(response: RecordValue, allowed: boolean): boolean {
  const sessionCapabilities = object(object(response.agentCapabilities).sessionCapabilities)
  return (
    allowed &&
    sessionCapabilities.list !== undefined &&
    sessionCapabilities.list !== null &&
    sessionCapabilities.list !== false
  )
}

/** Paginated `session/list`, with the duplicate/blank filtering and the
 * repeated-cursor guard `AcpBackend.listSessions` had. */
export async function listSessionsPaged(
  connection: acp.ClientSideConnection,
  cwd: string,
): Promise<ProviderSessionInfo[]> {
  const sessions: ProviderSessionInfo[] = []
  const seenSessionIds = new Set<string>()
  const seenCursors = new Set<string>()
  let cursor: string | undefined

  do {
    const response = object(
      await connection.listSessions({ cwd, ...(cursor ? { cursor } : {}) }),
    )
    const page = Array.isArray(response.sessions) ? response.sessions : []
    for (const value of page) {
      const info = object(value)
      const sessionId = string(info.sessionId)?.trim()
      const infoCwd = string(info.cwd)?.trim()
      if (!sessionId || !infoCwd || seenSessionIds.has(sessionId)) continue
      seenSessionIds.add(sessionId)
      const title = string(info.title)?.trim()
      const updatedAt = string(info.updatedAt)?.trim()
      sessions.push({
        sessionId,
        cwd: infoCwd,
        ...(title ? { title } : {}),
        ...(updatedAt ? { updatedAt } : {}),
      })
    }

    const nextCursor = string(response.nextCursor)?.trim()
    if (!nextCursor) break
    if (seenCursors.has(nextCursor)) {
      throw new Error('ACP session/list returned a repeated pagination cursor')
    }
    seenCursors.add(nextCursor)
    cursor = nextCursor
  } while (cursor)

  return sessions
}
