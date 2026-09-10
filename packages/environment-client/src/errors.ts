import type { ErrorCode, ProtocolError } from '@openmanager/protocol'

/**
 * Every command rejection is one of the protocol's error codes so UI can
 * choose a retry policy without knowing which implementation it talked to.
 * `capability_missing` doubles as "this environment does not implement the
 * command yet", which keeps interface-ahead-of-wire commands honest.
 */
export class EnvironmentClientError extends Error {
  readonly code: ErrorCode
  readonly details: unknown

  constructor(code: ErrorCode, message: string, details?: unknown) {
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
