import { describe, expect, it } from 'vitest'
import type { v2 } from '@openmanager/codex-app-server-protocol'
import {
  codexErrorName,
  codexNotice,
  codexProblem,
  codexRetryOf,
  codexRetryProblem,
  codexRpcProblem,
  codexThreadChangeNotice,
} from './codex-problems.js'

const error = (codexErrorInfo: v2.CodexErrorInfo | null, message = 'It went wrong'): v2.TurnError => ({
  message,
  codexErrorInfo,
  additionalDetails: null,
  misalignment: null,
})

const http = (name: string, httpStatusCode: number | null) =>
  ({ [name]: { httpStatusCode } }) as v2.CodexErrorInfo

describe('codexProblem', () => {
  // Every variant Codex 0.170 declares (`CodexErrorInfo.ts`), and its code.
  it.each([
    ['contextWindowExceeded', 'context_window_exceeded'],
    ['sessionBudgetExceeded', 'usage_limit'],
    ['usageLimitExceeded', 'usage_limit'],
    ['rateLimitExceeded', 'rate_limited'],
    ['flexUnavailable', 'overloaded'],
    ['serverOverloaded', 'overloaded'],
    ['modelNotFound', 'unknown'],
    ['policyCapacityUnavailable', 'overloaded'],
    ['inferenceHookDenied', 'refused'],
    ['cyberPolicy', 'refused'],
    ['misalignmentPolicyViolation', 'refused'],
    ['tooManyDenials', 'unknown'],
    ['internalServerError', 'server_error'],
    ['unauthorized', 'unauthorized'],
    ['badRequest', 'unknown'],
    ['threadRollbackFailed', 'unknown'],
    ['sandboxError', 'unknown'],
    ['other', 'unknown'],
  ] as const)('maps %s to %s', (variant, code) => {
    expect(codexProblem(error(variant))).toEqual({ code, detail: 'It went wrong' })
  })

  it.each([
    'httpConnectionFailed',
    'responseStreamConnectionFailed',
    'responseStreamDisconnected',
    'responseTooManyFailedAttempts',
  ])('maps %s to a network problem, or by its HTTP status when it has one', (variant) => {
    expect(codexProblem(error(http(variant, null))).code).toBe('network')
    expect(codexProblem(error(http(variant, 429))).code).toBe('rate_limited')
    expect(codexProblem(error(http(variant, 401))).code).toBe('unauthorized')
    expect(codexProblem(error(http(variant, 503))).code).toBe('overloaded')
    expect(codexProblem(error(http(variant, 500))).code).toBe('server_error')
    // An answered request that was refused is no connection problem: no retry.
    for (const status of [400, 404, 422])
      expect(codexProblem(error(http(variant, status))).code).toBe('unknown')
  })

  it('maps activeTurnNotSteerable, and a variant newer than these types, to unknown', () => {
    expect(codexProblem(error({ activeTurnNotSteerable: { turnKind: 'compact' } })).code).toBe('unknown')
    expect(codexProblem(error('somethingNew')).code).toBe('unknown')
    expect(codexProblem(error({ somethingNew: { x: 1 } } as never)).code).toBe('unknown')
    expect(codexProblem(error(null)).code).toBe('unknown')
  })

  it('shows a policy block’s explanation and Codex’s additional details', () => {
    expect(
      codexProblem({
        message: 'Blocked',
        codexErrorInfo: 'misalignmentPolicyViolation',
        additionalDetails: 'See the usage policy.',
        misalignment: {
          errorType: 'x',
          detailedExplanation: 'This request asked for something the policy does not allow.',
          steer: null,
        },
      }),
    ).toEqual({
      code: 'refused',
      detail: 'This request asked for something the policy does not allow.\n\nSee the usage policy.',
    })
  })

  it('reads a typed problem from a refused request’s error data', () => {
    expect(codexRpcProblem({ codexErrorInfo: 'usageLimitExceeded' }, 'Out of credits')).toEqual({
      code: 'usage_limit',
      detail: 'Out of credits',
    })
    expect(codexRpcProblem(undefined, 'x')).toBeUndefined()
    expect(codexRpcProblem({ other: 1 }, 'x')).toBeUndefined()
  })

  it('names variants plain and tagged', () => {
    expect(codexErrorName('unauthorized')).toBe('unauthorized')
    expect(codexErrorName(http('httpConnectionFailed', 502))).toBe('httpConnectionFailed')
    expect(codexErrorName(null)).toBeUndefined()
  })
})

describe('codex retries', () => {
  it('reads "Reconnecting n/m" as the retry’s progress', () => {
    expect(codexRetryOf('Reconnecting... 2/5')).toEqual({ attempt: 2, maxAttempts: 5 })
    expect(codexRetryOf('stream disconnected; retrying 1 / 3')).toEqual({ attempt: 1, maxAttempts: 3 })
    expect(codexRetryOf('Something else 2/5')).toBeUndefined()
  })

  it('types a willRetry error, with its progress and without detail', () => {
    expect(
      codexRetryProblem({
        threadId: 't',
        turnId: 'u',
        willRetry: true,
        error: error(http('responseStreamDisconnected', null), 'Reconnecting... 1/5'),
      }),
    ).toEqual({ code: 'network', retry: { attempt: 1, maxAttempts: 5 } })
  })
})

describe('codexNotice', () => {
  it('shows Codex’s warnings, config warnings and deprecations', () => {
    expect(codexNotice('warning', { threadId: null, message: 'Heads up' })).toEqual({
      kind: 'warning',
      message: 'Heads up',
    })
    expect(codexNotice('guardianWarning', { threadId: 't', message: 'Careful' })).toEqual({
      kind: 'warning',
      message: 'Careful',
    })
    expect(
      codexNotice('configWarning', {
        summary: 'bubblewrap not found',
        details: 'Using the bundled copy.',
        path: '/home/me/.codex/config.toml',
      }),
    ).toEqual({
      kind: 'warning',
      message: 'bubblewrap not found',
      detail: 'Using the bundled copy.\n\nIn /home/me/.codex/config.toml',
    })
    expect(codexNotice('deprecationNotice', { summary: 'Old flag', details: null })).toEqual({
      kind: 'warning',
      message: 'Old flag',
    })
    expect(codexNotice('warning', { threadId: null, message: '  ' })).toBeUndefined()
  })

  it('shows a reroute as a model switch, and a verification', () => {
    expect(
      codexNotice('model/rerouted', {
        threadId: 't',
        turnId: 'u',
        fromModel: 'gpt-6',
        toModel: 'gpt-6-safe',
        reason: 'highRiskCyberActivity',
      }),
    ).toMatchObject({ kind: 'model_fallback', model: { from: 'gpt-6', to: 'gpt-6-safe' } })
    expect(
      codexNotice('model/verification', {
        threadId: 't',
        turnId: 'u',
        verifications: ['trustedAccessForCyber'],
      }),
    ).toEqual({ kind: 'info', message: 'Codex verified this turn for trusted access for cyber' })
  })

  it('shows an MCP server that failed to start, and nothing for one that started', () => {
    const status = {
      threadId: null,
      name: 'linear',
      error: 'token expired',
      failureReason: 'reauthenticationRequired' as const,
    }
    expect(codexNotice('mcpServer/startupStatus/updated', { ...status, status: 'failed' })).toEqual({
      kind: 'warning',
      message: 'The MCP server linear did not start',
      detail: 'Sign in to linear again (`codex mcp login linear`).\n\ntoken expired',
    })
    expect(
      codexNotice('mcpServer/startupStatus/updated', { ...status, status: 'ready' }),
    ).toBeUndefined()
  })

  it('has nothing to say about anything else', () => {
    expect(codexNotice('account/updated', {})).toBeUndefined()
  })

  it('words every outside change to the thread', () => {
    for (const change of ['closed', 'archived', 'deleted', 'unarchived', 'reverted', 'systemError'] as const)
      expect(codexThreadChangeNotice(change).message).toBeTruthy()
  })
})
