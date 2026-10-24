import type { ErrorCode, ProtocolError } from '@openmanager/protocol'

/**
 * Every command rejection is one of the protocol's error codes so UI can
 * choose a retry policy without knowing which implementation it talked to.
 * `capability_missing` doubles as "this environment does not implement the
 * command yet", which keeps interface-ahead-of-wire commands honest.
 */
/**
 * The protocol's codes, plus `superseded`, which only this client raises: an
 * open overtaken by an open of another session or by a new selection
 * (docs/sync-foundations.md §4.7.5). Callers treat it as "nothing to do".
 */
export type ClientErrorCode = ErrorCode | 'superseded'

export class EnvironmentClientError extends Error {
  readonly code: ClientErrorCode
  readonly details: unknown

  constructor(code: ClientErrorCode, message: string, details?: unknown) {
    super(message)
    this.name = 'EnvironmentClientError'
    this.code = code
    this.details = details
  }

  static fromProtocol(error: ProtocolError): EnvironmentClientError {
    return new EnvironmentClientError(error.code, error.message, error.details)
  }

  static unsupported(command: string): EnvironmentClientError {
    return new EnvironmentClientError(
      'capability_missing',
      `This environment does not support ${command}.`,
      { command },
    )
  }
}

export function isEnvironmentClientError(error: unknown): error is EnvironmentClientError {
  return error instanceof EnvironmentClientError
}

/** An open that something newer replaced: not a failure, nothing to show. */
export function isSuperseded(error: unknown): boolean {
  return isEnvironmentClientError(error) && error.code === 'superseded'
}
