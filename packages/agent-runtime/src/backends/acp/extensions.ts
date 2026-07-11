export type ExtensionRequestHandler = (params: unknown) => unknown | Promise<unknown>
export type ExtensionNotificationHandler = (params: unknown) => void | Promise<void>
export type ExtensionHandlers = {
  requests?: Record<string, ExtensionRequestHandler>
  notifications?: Record<string, ExtensionNotificationHandler>
}
export class ExtensionRegistry {
  constructor(private readonly handlers: ExtensionHandlers = {}) {}
  async request(method: string, params: unknown): Promise<unknown> {
    return this.handlers.requests?.[method]?.(params) ?? { outcome: { outcome: 'cancelled' } }
  }
  async notification(method: string, params: unknown): Promise<void> {
    await this.handlers.notifications?.[method]?.(params)
  }
}
