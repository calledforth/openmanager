import { CODEX_APP_SERVER_PROTOCOL_VERSION } from '@openmanager/codex-app-server-protocol'
import { describe, expect, it } from 'vitest'
import {
  checkCodexVersion,
  CODEX_MIN_VERSION,
  CODEX_RECOMMENDED_VERSION,
  compareVersions,
  parseCodexVersion,
} from './version.js'

describe('parseCodexVersion', () => {
  it('reads the version from a real initialize userAgent', () => {
    // Probed from codex-cli 0.170.0 with clientInfo.name "OpenManager".
    expect(
      parseCodexVersion('OpenManager/0.170.0 (Ubuntu 24.4.0; x86_64) unknown (OpenManager; 0.0.0-probe)'),
    ).toBe('0.170.0')
  })

  it('keeps a pre-release suffix and tolerates surrounding whitespace', () => {
    expect(parseCodexVersion('  OpenManager/0.171.0-alpha.2 (macOS; arm64)  ')).toBe('0.171.0-alpha.2')
  })

  it('reads nothing from an agent without a version', () => {
    expect(parseCodexVersion('')).toBeUndefined()
    expect(parseCodexVersion('garbage')).toBeUndefined()
    expect(parseCodexVersion('OpenManager/dev (Linux)')).toBeUndefined()
    // The version must follow the first `/`, not appear anywhere.
    expect(parseCodexVersion('something 0.170.0')).toBeUndefined()
  })
})

describe('compareVersions', () => {
  it('compares numerically, not as strings', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0)
    expect(compareVersions('0.160.0', '0.170.0')).toBeLessThan(0)
    expect(compareVersions('1.0.0', '0.999.999')).toBeGreaterThan(0)
    expect(compareVersions('0.170.0', '0.170.0')).toBe(0)
  })

  it('treats missing parts as zero', () => {
    expect(compareVersions('1.0', '1.0.0')).toBe(0)
    expect(compareVersions('1.0.1', '1.0')).toBeGreaterThan(0)
  })

  it('ignores pre-release and build suffixes', () => {
    // Deliberate: a developer ahead of a release counts as that release,
    // where semver would order 0.171.0-alpha.2 below 0.171.0.
    expect(compareVersions('0.171.0-alpha.2', '0.171.0')).toBe(0)
    expect(compareVersions('0.171.0+build.7', '0.171.0')).toBe(0)
    expect(compareVersions('0.171.0-alpha.2', '0.170.0')).toBeGreaterThan(0)
    expect(compareVersions('0.159.0-rc.1', CODEX_MIN_VERSION)).toBeLessThan(0)
  })
})

describe('checkCodexVersion', () => {
  it('pins the recommended version to the vendored protocol', () => {
    expect(CODEX_RECOMMENDED_VERSION).toBe(CODEX_APP_SERVER_PROTOCOL_VERSION)
    expect(compareVersions(CODEX_MIN_VERSION, CODEX_RECOMMENDED_VERSION)).toBeLessThanOrEqual(0)
  })

  it('classifies by the minimum and the pinned version', () => {
    expect(checkCodexVersion('OpenManager/0.150.0 (Linux)')).toEqual({
      version: '0.150.0',
      status: 'unsupported',
    })
    expect(checkCodexVersion(`OpenManager/${CODEX_MIN_VERSION} (Linux)`).status).toBe('outdated')
    expect(checkCodexVersion('OpenManager/0.165.0 (Linux)')).toEqual({
      version: '0.165.0',
      status: 'outdated',
    })
    expect(checkCodexVersion(`OpenManager/${CODEX_RECOMMENDED_VERSION} (Linux)`).status).toBe(
      'supported',
    )
    expect(checkCodexVersion('OpenManager/0.200.0 (Linux)').status).toBe('supported')
  })

  it('reports unknown rather than guessing when the agent is unreadable', () => {
    expect(checkCodexVersion('garbage')).toEqual({ status: 'unknown' })
  })

  it('runs a source build (0.0.0) as unknown instead of refusing it as ancient', () => {
    expect(checkCodexVersion('OpenManager/0.0.0 (Linux; x86_64)')).toEqual({
      version: '0.0.0',
      status: 'unknown',
    })
    expect(checkCodexVersion('OpenManager/0.0.0-dev (Linux; x86_64)').status).toBe('unknown')
    // Only exactly 0.0.0: a real but ancient release is still refused.
    expect(checkCodexVersion('OpenManager/0.0.1 (Linux; x86_64)').status).toBe('unsupported')
  })
})
