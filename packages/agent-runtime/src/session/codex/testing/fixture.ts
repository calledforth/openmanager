import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { WireMessage } from './FakeCodexAppServer.js'

/** A recorded `codex app-server` conversation, replayed in tests.
 *
 * ## Format (`openmanager.codex-replay/1`)
 *
 * JSON Lines. The first line is a header:
 *
 *     {"format":"openmanager.codex-replay/1","scenario":"simple-turn",
 *      "description":"…","codexVersion":"0.170.0","model":"gpt-6-luna",
 *      "recordedAt":"2026-11-20","config":[],"placeholders":{…}}
 *
 * Every other line is one thing that happened, in the order it happened, with
 * `atMs`, milliseconds since the process was spawned:
 *
 *     {"atMs":6,"from":"client","message":{"id":1,"method":"initialize",…}}
 *     {"atMs":397,"from":"server","message":{"id":1,"result":{…}}}
 *     {"atMs":370,"from":"server","stderr":"… ERROR codex_app_server: …"}
 *     {"atMs":12,"from":"server","raw":"a stdout line that was not JSON"}
 *     {"atMs":8976,"from":"server","exit":{"code":0,"signal":null,"cause":"client"}}
 *
 * `message` is the JSON-RPC message exactly as it crossed the pipe, ids
 * included. An `exit` with `cause: "client"` is the recorder shutting Codex
 * down and marks the end; one without is a crash, which a replay plays.
 *
 * Recordings are sanitised before they are written (see
 * `scripts/record-codex-fixture.mjs`): the workspace is `/workspace`, the home
 * directory `/home/user`, Codex's home `/home/user/.codex`, account ids and
 * emails are placeholders, and anything token-like is `<redacted…>`. */

export const CODEX_FIXTURE_FORMAT = 'openmanager.codex-replay/1'

export type CodexFixtureHeader = {
  format: typeof CODEX_FIXTURE_FORMAT
  scenario: string
  description: string
  /** The CLI that was recorded. */
  codexVersion: string
  model: string | null
  /** `YYYY-MM-DD`. */
  recordedAt: string
  /** `-c` overrides the app-server was started with. */
  config: string[]
  placeholders: Record<string, string>
}

export type CodexFixtureExit = {
  code: number | null
  signal: NodeJS.Signals | null
  /** `client`: the recorder stopped it, so it is the end of the recording, not
   * something to play. */
  cause?: 'client'
}

export type CodexFixtureEntry =
  | { atMs: number; from: 'client'; message: WireMessage }
  | { atMs: number; from: 'server'; message: WireMessage }
  | { atMs: number; from: 'server'; stderr: string }
  | { atMs: number; from: 'server'; raw: string }
  | { atMs: number; from: 'server'; exit: CodexFixtureExit }

export type CodexFixture = {
  header: CodexFixtureHeader
  entries: CodexFixtureEntry[]
}

/** The fixtures recorded from the real CLI and committed with this package. */
export const CODEX_FIXTURES = [
  'simple-turn',
  'command-approval',
  'file-change-approval',
  'permissions-approval',
  'subagent',
  'interrupt-with-child',
  'steer',
  'tool-items',
  'terminal-interaction',
  'compact',
  'auto-compact',
  'review',
  'review-interrupt',
  'image-view',
  'image-generation',
] as const
export type CodexFixtureName = (typeof CODEX_FIXTURES)[number]

export function parseCodexFixture(text: string): CodexFixture {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '')
  const [first, ...rest] = lines
  if (first === undefined) throw new Error('empty codex fixture')
  const header = JSON.parse(first) as CodexFixtureHeader
  if (header.format !== CODEX_FIXTURE_FORMAT)
    throw new Error(`not a codex fixture (format ${JSON.stringify(header.format)}, expected ${CODEX_FIXTURE_FORMAT})`)
  const entries = rest.map((line, index) => {
    const entry = JSON.parse(line) as CodexFixtureEntry
    if (entry.from !== 'client' && entry.from !== 'server')
      throw new Error(`codex fixture line ${index + 2} has no from`)
    return entry
  })
  return { header, entries }
}

export function serializeCodexFixture(fixture: CodexFixture): string {
  return [fixture.header, ...fixture.entries].map((line) => JSON.stringify(line)).join('\n') + '\n'
}

/** A committed fixture by name, or any fixture file by path. */
export function readCodexFixture(nameOrPath: CodexFixtureName | (string & {})): CodexFixture {
  const path = (CODEX_FIXTURES as readonly string[]).includes(nameOrPath)
    ? codexTestingAsset(`fixtures/${nameOrPath}.jsonl`)
    : nameOrPath
  return parseCodexFixture(readFileSync(path, 'utf8'))
}

/** Path to the spawnable mock app-server (`mock-app-server.mjs`). */
export function codexMockAppServerPath(): string {
  return codexTestingAsset('mock-app-server.mjs')
}

/** A file that lives next to this module in `src`. The build compiles only the
 * TypeScript into `dist`, so should this module ever run from `dist` the file
 * is looked up in `src`. */
function codexTestingAsset(relative: string): string {
  const beside = fileURLToPath(new URL(relative, import.meta.url))
  if (existsSync(beside)) return beside
  return fileURLToPath(new URL(`../../../../src/session/codex/testing/${relative}`, import.meta.url))
}

/** Messages of one side, in order. */
export function fixtureMessages(fixture: CodexFixture, from: 'client' | 'server'): WireMessage[] {
  return fixture.entries.flatMap((entry) => (entry.from === from && 'message' in entry ? [entry.message] : []))
}
