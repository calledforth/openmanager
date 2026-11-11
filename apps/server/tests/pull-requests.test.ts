import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PULL_REQUEST_CHECK_RUNS_MAX,
  PULL_REQUESTS_PER_SESSION_MAX,
  ProofEventSchemas,
  PullRequestDetailSchema,
  PullRequestSummaryListSchema,
  type ProofEvent,
} from '@openmanager/protocol/node'
import { openEnvironmentDatabase } from '../src/db/database.js'
import { getSessionSummary } from '../src/db/session-store.js'
import { createPersistentEventService } from '../src/event-service.js'
import {
  createGitHubReader,
  createGitHubToken,
  pullRequestFromGraphQL,
  pullRequestQuery,
  readResultsFromGraphQL,
  type GitHubReader,
  type PullRequestRead,
  type PullRequestReadResult,
} from '../src/pull-requests/github.js'
import { createPullRequestService } from '../src/pull-requests/service.js'
import {
  parsePullRequestUrl,
  pullRequestCreatedBy,
  runsGhPrCreate,
  shellCommandOf,
  type PullRequestRef,
} from '../src/pull-requests/url.js'

const REF: PullRequestRef = {
  repository: 'calledforth/openmanager',
  number: 298,
  url: 'https://github.com/calledforth/openmanager/pull/298',
}

describe('pull request URLs', () => {
  it('reads a pull request URL and what may follow it', () => {
    for (const text of [
      'https://github.com/calledforth/openmanager/pull/298',
      'https://github.com/calledforth/openmanager/pull/298/files',
      'https://github.com/calledforth/openmanager/pull/298#issuecomment-1',
      '  https://www.github.com/calledforth/openmanager/pull/298?w=1  ',
    ]) {
      expect(parsePullRequestUrl(text)).toEqual(REF)
    }
  })

  it('refuses anything that is not one', () => {
    for (const text of [
      '',
      'calledforth/openmanager#298',
      'https://github.com/calledforth/openmanager/issues/298',
      'https://github.com/calledforth/openmanager/pull/0',
      'https://github.com/calledforth/openmanager/pull/abc',
      'https://gitlab.com/calledforth/openmanager/pull/298',
      'https://github.com.evil.example/calledforth/openmanager/pull/298',
    ]) {
      expect(parsePullRequestUrl(text)).toBeNull()
    }
  })
})

describe('gh pr create', () => {
  it('recognises the command, alone or in a chain', () => {
    for (const command of [
      'gh pr create --fill',
      'git push -u origin HEAD && gh pr create --title "x" --body "y"',
      'cd repo; gh pr create',
      '"C:\\Program Files\\GitHub CLI\\gh.exe" pr create --draft',
      '/usr/bin/gh pr create',
    ]) {
      expect(runsGhPrCreate(command)).toBe(true)
    }
  })

  it('never takes a command that only reads pull requests', () => {
    for (const command of [
      'gh pr view 298',
      'gh pr list --state all',
      'gh pr checks 298',
      'git log --oneline',
      'cat notes.md',
      'sigh pr create',
    ]) {
      expect(runsGhPrCreate(command)).toBe(false)
    }
  })

  it('reads the command from a tool input', () => {
    expect(shellCommandOf({ command: 'gh pr create', description: 'Open PR' })).toBe('gh pr create')
    expect(shellCommandOf({ command: ['gh', 'pr', 'create'] })).toBe('gh pr create')
    expect(shellCommandOf({ file_path: 'a.ts' })).toBeUndefined()
    expect(shellCommandOf('gh pr create')).toBeUndefined()
  })

  it('never takes a dry run, which prints the body and opens nothing', () => {
    expect(runsGhPrCreate('gh pr create --dry-run --body-file b.md')).toBe(false)
    expect(runsGhPrCreate('gh pr create --fill --dry-run')).toBe(false)
    expect(runsGhPrCreate('gh pr create --fill --title "no --dry-run-ish"')).toBe(true)
  })

  it('finds the pull request it opened, or the one that already existed', () => {
    expect(
      pullRequestCreatedBy(
        'Creating pull request for feat into main in calledforth/openmanager\n\nhttps://github.com/calledforth/openmanager/pull/298\n',
      ),
    ).toEqual({ ref: REF, existingHead: null })
    expect(
      pullRequestCreatedBy(
        'a pull request for branch "feat" into branch "main" already exists:\nhttps://github.com/calledforth/openmanager/pull/298\n',
      ),
    ).toEqual({ ref: REF, existingHead: 'feat' })
    // More than one candidate: which one is new cannot be told.
    expect(
      pullRequestCreatedBy(
        'https://github.com/calledforth/openmanager/pull/298\nhttps://github.com/calledforth/openmanager/pull/297\n',
      ),
    ).toBeNull()
    // The same one twice is still one.
    expect(
      pullRequestCreatedBy(`${REF.url}\nhttps://github.com/CalledForth/OpenManager/pull/298\n`),
    ).toEqual({ ref: REF, existingHead: null })
    // A URL inside prose is not what gh printed.
    expect(
      pullRequestCreatedBy('see https://github.com/calledforth/openmanager/pull/12 for context'),
    ).toBeNull()
    expect(pullRequestCreatedBy('GraphQL: Head sha can not be blank')).toBeNull()
  })
})

const GRAPHQL_NODE = {
  url: 'https://github.com/calledforth/openmanager/pull/298',
  title: 'Search what was said in chats',
  state: 'OPEN',
  isDraft: false,
  merged: false,
  body: '## Summary\nSearch.',
  author: { login: 'calledforth', avatarUrl: 'https://avatars.githubusercontent.com/u/1' },
  headRefName: 'feat/search',
  baseRefName: 'main',
  additions: 1200,
  deletions: 40,
  changedFiles: 31,
  commits: { totalCount: 7 },
  createdAt: '2026-11-08T10:00:00Z',
  updatedAt: '2026-11-09T12:00:00Z',
  mergedAt: null,
  closedAt: null,
  reviewDecision: 'CHANGES_REQUESTED',
  labels: {
    nodes: [
      { name: 'sync', color: 'a2eeef' },
      { name: 'bad', color: 'zz' },
    ],
  },
  latestReviews: {
    nodes: [
      { state: 'CHANGES_REQUESTED', author: { login: 'reviewer', avatarUrl: null } },
      { state: 'DISMISSED', author: { login: 'gone', avatarUrl: null } },
    ],
  },
  reviewRequests: {
    nodes: [
      { requestedReviewer: { __typename: 'Team', slug: 'core', avatarUrl: null } },
      { requestedReviewer: { __typename: 'User', login: 'reviewer', avatarUrl: null } },
    ],
  },
  headCommit: {
    nodes: [
      {
        commit: {
          statusCheckRollup: {
            state: 'FAILURE',
            contexts: {
              nodes: [
                {
                  __typename: 'CheckRun',
                  name: 'test',
                  status: 'COMPLETED',
                  conclusion: 'FAILURE',
                  detailsUrl: 'https://github.com/x/runs/1',
                },
                { __typename: 'CheckRun', name: 'lint', status: 'IN_PROGRESS', conclusion: null },
                {
                  __typename: 'StatusContext',
                  context: 'Workers Builds',
                  state: 'SUCCESS',
                  targetUrl: null,
                },
              ],
            },
          },
        },
      },
    ],
  },
}

describe('GitHub GraphQL', () => {
  it('maps a pull request to the protocol', () => {
    expect(pullRequestFromGraphQL(REF, GRAPHQL_NODE)).toEqual({
      url: REF.url,
      repository: REF.repository,
      number: 298,
      title: 'Search what was said in chats',
      state: 'open',
      labels: [{ name: 'sync', color: 'a2eeef' }],
      checks: 'failing',
      reviewDecision: 'changes_requested',
      additions: 1200,
      deletions: 40,
      updatedAt: '2026-11-09T12:00:00.000Z',
      body: '## Summary\nSearch.',
      author: { login: 'calledforth', avatarUrl: 'https://avatars.githubusercontent.com/u/1' },
      headRef: 'feat/search',
      baseRef: 'main',
      createdAt: '2026-11-08T10:00:00.000Z',
      mergedAt: null,
      closedAt: null,
      changedFiles: 31,
      commits: 7,
      reviewers: [
        { login: 'reviewer', avatarUrl: null, state: 'changes_requested' },
        { login: 'core', avatarUrl: null, state: 'requested' },
      ],
      checkRuns: [
        { name: 'test', state: 'failure', url: 'https://github.com/x/runs/1' },
        { name: 'lint', state: 'pending', url: null },
        { name: 'Workers Builds', state: 'success', url: null },
      ],
    })
    expect(pullRequestFromGraphQL(REF, { ...GRAPHQL_NODE, isDraft: true }).state).toBe('draft')
    expect(pullRequestFromGraphQL(REF, { ...GRAPHQL_NODE, merged: true }).state).toBe('merged')
    expect(pullRequestFromGraphQL(REF, { ...GRAPHQL_NODE, state: 'CLOSED' }).state).toBe('closed')
  })

  it('lists one page of check runs and carries GitHub count of them all', () => {
    const run = (n: number) => ({
      __typename: 'CheckRun',
      name: `check ${n}`,
      status: 'COMPLETED',
      conclusion: 'SUCCESS',
    })
    const node = {
      ...GRAPHQL_NODE,
      headCommit: {
        nodes: [
          {
            commit: {
              statusCheckRollup: {
                state: 'FAILURE',
                contexts: {
                  totalCount: 140,
                  nodes: Array.from({ length: PULL_REQUEST_CHECK_RUNS_MAX + 5 }, (_, n) => run(n)),
                },
              },
            },
          },
        ],
      },
    }
    const read = pullRequestFromGraphQL(REF, node)
    expect(read.checkRuns).toHaveLength(PULL_REQUEST_CHECK_RUNS_MAX)
    expect(read.checkRunsTotal).toBe(140)
    expect(
      PullRequestDetailSchema.parse({
        ...read,
        linkedAt: '2026-11-10T10:00:00.000Z',
        syncedAt: null,
        problem: null,
      }),
    ).toMatchObject({ checkRunsTotal: 140 })
    expect(pullRequestQuery([REF]).query).toContain(
      `contexts(first: ${PULL_REQUEST_CHECK_RUNS_MAX}) {\n            totalCount`,
    )
    // A rollup without a count says none.
    expect('checkRunsTotal' in pullRequestFromGraphQL(REF, GRAPHQL_NODE)).toBe(false)
  })

  it('asks for every pull request in one query, by variables', () => {
    const { query, variables } = pullRequestQuery([REF, { ...REF, number: 1 }])
    expect(query).toContain('pr0: repository(owner: $o0, name: $n0)')
    expect(query).toContain('pr1: repository(owner: $o1, name: $n1)')
    expect(variables).toEqual({
      o0: 'calledforth',
      n0: 'openmanager',
      p0: 298,
      o1: 'calledforth',
      n1: 'openmanager',
      p1: 1,
    })
  })

  it('tells a missing pull request from a failed read, alias by alias', () => {
    const results = readResultsFromGraphQL([REF, { ...REF, number: 2 }, { ...REF, number: 3 }], {
      data: { pr0: { pullRequest: GRAPHQL_NODE }, pr1: { pullRequest: null }, pr2: null },
      errors: [
        { type: 'NOT_FOUND', path: ['pr1', 'pullRequest'] },
        { type: 'SOMETHING', path: ['pr2'] },
      ],
    })
    expect('read' in results[0]!).toBe(true)
    expect(results.slice(1)).toEqual([{ problem: 'not_found' }, { problem: 'unreachable' }])
  })

  it('reads the token again once after GitHub refuses it', async () => {
    const tokens = ['old', 'new']
    const token = createGitHubToken({
      execFile: async () => ({ stdout: `${tokens.shift() ?? ''}\n` }),
      env: {},
    })
    const seen: string[] = []
    const reader = createGitHubReader({
      token,
      fetch: async (_url, init) => {
        const auth = String((init.headers as Record<string, string>).authorization)
        seen.push(auth)
        return auth.endsWith('old')
          ? new Response('', { status: 401 })
          : Response.json({ data: { pr0: { pullRequest: GRAPHQL_NODE } } })
      },
    })
    const [result] = await reader.read([REF])
    expect(seen).toEqual(['bearer old', 'bearer new'])
    expect(result && 'read' in result && result.read.title).toBe('Search what was said in chats')
  })

  it('is not signed in without gh or a token, and unreachable when GitHub fails', async () => {
    const missing = createGitHubToken({
      execFile: async () => {
        throw new Error('gh: not found')
      },
      env: {},
    })
    await expect(createGitHubReader({ token: missing }).read([REF])).resolves.toEqual([
      { problem: 'not_signed_in' },
    ])
    const fromEnv = createGitHubToken({
      execFile: async () => {
        throw new Error('gh: not found')
      },
      env: { GITHUB_TOKEN: 'env-token' },
    })
    await expect(fromEnv.get()).resolves.toBe('env-token')
    const failing = createGitHubReader({
      token: fromEnv,
      fetch: async () => {
        throw new Error('ECONNRESET')
      },
    })
    await expect(failing.read([REF])).resolves.toEqual([{ problem: 'unreachable' }])
  })
})

// ------------------------------------------------------------------ the service

const directories: string[] = []
const cleanups: (() => void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const READ = pullRequestFromGraphQL(REF, GRAPHQL_NODE)

async function harness(
  reads: (refs: readonly PullRequestRef[]) => PullRequestReadResult[] = (refs) =>
    refs.map((ref) => ({ read: { ...READ, repository: ref.repository, number: ref.number } })),
  options: { now?: () => number; failWrites?: () => boolean } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'openmanager-pr-test-'))
  directories.push(directory)
  const database = openEnvironmentDatabase(directory)
  database.exec(`
    INSERT INTO workspaces (workspace_id, name, path, created_at, updated_at)
      VALUES ('workspace-1', 'Workspace', '/workspace', 1, 1);
    INSERT INTO sessions (session_id, workspace_id, provider_id, status, created_at, updated_at)
      VALUES ('session-1', 'workspace-1', 'claude', 'idle', 1, 1);
    INSERT INTO sessions (session_id, workspace_id, parent_session_id, provider_id, status, created_at, updated_at)
      VALUES ('child-1', 'workspace-1', 'session-1', 'claude', 'idle', 1, 1);
    INSERT INTO threads (thread_id, session_id, workspace_id, created_at, updated_at)
      VALUES ('thread-1', 'session-1', 'workspace-1', 1, 1),
             ('child-thread-1', 'child-1', 'workspace-1', 1, 1);
  `)
  const published: ProofEvent[] = []
  const events = createPersistentEventService(database, (record) => published.push(record.event))
  const github: GitHubReader = { read: vi.fn(async (refs) => reads(refs)) }
  const service = createPullRequestService({
    database,
    github,
    environmentId: () => 'environment-1',
    appendAtomic: (list, writeOptions) => {
      // A write that fails the way `appendAtomic` can: its flush throws first.
      if (options.failWrites?.()) throw new Error('SQLITE_BUSY: database is locked')
      return events.appendAtomic(list, writeOptions)
    },
    flush: () => events.flush(),
    anyClientConnected: () => true,
    log: () => undefined,
    ...(options.now ? { now: options.now } : {}),
  })
  cleanups.push(() => {
    service.stop()
    events.close()
    database.close()
  })
  const tool = service.tools[0]!
  const call = (url: string, threadId = 'thread-1') =>
    tool.call({ url }, { threadId, providerId: 'claude' })
  return { database, published, service, github, call }
}

const listed = (database: DatabaseSync, sessionId = 'session-1') =>
  getSessionSummary(database, sessionId)?.pullRequests

describe('linking', () => {
  it('creates both tables', async () => {
    const { database } = await harness()
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%pull_requests'")
      .all()
      .map((row) => (row as { name: string }).name)
      .sort()
    expect(tables).toEqual(['pull_requests', 'session_pull_requests'])
  })

  it('links from a sub-agent to the root session, reads GitHub, and says so', async () => {
    const { database, published, call } = await harness()
    const answer = await call(`${REF.url}/files`, 'child-thread-1')
    expect(answer).toEqual({
      text: 'Linked calledforth/openmanager#298 "Search what was said in chats" (open) to this session.',
    })
    expect(listed(database, 'child-1')).toBeUndefined()
    const [summary] = listed(database) ?? []
    expect(summary).toMatchObject({
      url: REF.url,
      repository: REF.repository,
      number: 298,
      title: 'Search what was said in chats',
      state: 'open',
      checks: 'failing',
      problem: null,
    })
    // The link, then what the read found: each the session's whole list.
    const updates = published.filter((event) => event.name === 'session.updated')
    expect(updates.map((event) => event.payload)).toEqual([
      { sessionId: 'session-1', pullRequests: [expect.objectContaining({ title: null })] },
      { sessionId: 'session-1', pullRequests: [summary] },
    ])
    expect(PullRequestSummaryListSchema.parse(listed(database))).toHaveLength(1)
    const source = database.prepare('SELECT source FROM session_pull_requests').get()
    expect(source).toEqual({ source: 'tool' })
  })

  it('is idempotent, whatever case the URL is in', async () => {
    const { database, published, call, github } = await harness()
    await call(REF.url)
    const before = published.length
    const again = await call('https://github.com/CalledForth/OpenManager/pull/298')
    expect(again.text).toContain('was already linked to this session')
    expect(again.isError).toBeUndefined()
    expect(listed(database)).toHaveLength(1)
    expect(published.length).toBe(before)
    expect(github.read).toHaveBeenCalledTimes(1)
  })

  it('refuses a URL that is not a pull request, and a full session', async () => {
    const { database, call } = await harness()
    await expect(
      call('https://github.com/calledforth/openmanager/issues/1'),
    ).resolves.toMatchObject({ isError: true })
    const insert = database.prepare(
      `INSERT INTO session_pull_requests (session_id, repository, number, url, linked_at, source, summary_json)
       VALUES ('session-1', 'o/r', ?, 'https://github.com/o/r/pull/1', 1, 'tool', '{}')`,
    )
    for (let n = 1; n <= PULL_REQUESTS_PER_SESSION_MAX; n += 1) insert.run(n)
    const full = await call(REF.url)
    expect(full.isError).toBe(true)
    expect(full.text).toContain(`already links ${PULL_REQUESTS_PER_SESSION_MAX}`)
  })

  it('keeps the link and names the problem when GitHub cannot be read', async () => {
    const { database, call } = await harness((refs) =>
      refs.map(() => ({ problem: 'not_signed_in' })),
    )
    const answer = await call(REF.url)
    expect(answer.text).toContain('Linked calledforth/openmanager#298 to this session.')
    expect(answer.text).toContain('not_signed_in')
    expect(listed(database)?.[0]).toMatchObject({ title: null, problem: 'not_signed_in' })
  })

  describe('from gh pr create', () => {
    // READ was created at 2026-11-08T10:00:00Z from the head `feat/search`.
    const CREATED_AT = Date.parse('2026-11-08T10:00:00Z')

    it('links the one it opened, confirmed by GitHub, with what it read, in one event', async () => {
      const { database, service, published, github } = await harness()
      await service.observeSettledTool({
        sessionId: 'child-1',
        output: `Creating pull request for feat/search into main\n\n${REF.url}\n`,
        startedAt: CREATED_AT - 5_000,
      })
      expect(listed(database)).toEqual([
        expect.objectContaining({ number: 298, title: 'Search what was said in chats' }),
      ])
      expect(database.prepare('SELECT source FROM session_pull_requests').get()).toEqual({
        source: 'gh_pr_create',
      })
      // Never shown before GitHub confirmed it: the first event already has the read.
      const updates = published.filter((event) => event.name === 'session.updated')
      expect(updates).toHaveLength(1)
      // Linked already: the next settle reads nothing and links nothing.
      await service.observeSettledTool({
        sessionId: 'session-1',
        output: `${REF.url}\n`,
        startedAt: CREATED_AT,
      })
      expect(github.read).toHaveBeenCalledTimes(1)
      expect(service.wantsToolInput({ command: 'gh pr create --fill' })).toBe(true)
      expect(service.wantsToolInput({ command: 'gh pr view 298' })).toBe(false)
    })

    it('links the one that already existed for the branch it named', async () => {
      const { database, service } = await harness()
      await service.observeSettledTool({
        sessionId: 'session-1',
        output: `a pull request for branch "someone:feat/search" into branch "main" already exists:\n${REF.url}\n`,
        // Long after it was opened: gh found it, it did not open it.
        startedAt: CREATED_AT + 86_400_000,
      })
      expect(listed(database)).toHaveLength(1)
    })

    it('links nothing GitHub does not confirm', async () => {
      const { database, service, published } = await harness()
      const later = CREATED_AT + 86_400_000
      // gh pr create failed, and a list printed one old pull request.
      await service.observeSettledTool({
        sessionId: 'session-1',
        output: `pull request create failed: GraphQL: No commits between main and feat\n${REF.url}\n`,
        startedAt: later,
      })
      // "Already exists" for another branch than the one GitHub has.
      await service.observeSettledTool({
        sessionId: 'session-1',
        output: `a pull request for branch "other" into branch "main" already exists:\n${REF.url}\n`,
        startedAt: later,
      })
      // `gh pr create --fill; gh pr list --json url -q '.[].url'`: several printed.
      await service.observeSettledTool({
        sessionId: 'session-1',
        output: `${REF.url}\nhttps://github.com/calledforth/openmanager/pull/297\n`,
        startedAt: CREATED_AT - 5_000,
      })
      expect(listed(database) ?? []).toEqual([])
      expect(published.filter((event) => event.name === 'session.updated')).toEqual([])
      // `--dry-run` prints the body, which may hold a pull request URL on a
      // line of its own; the command is never watched.
      expect(service.wantsToolInput({ command: 'gh pr create --dry-run --body-file b.md' })).toBe(
        false,
      )
    })

    it('links nothing when GitHub cannot be read to confirm it', async () => {
      const { database, service } = await harness((refs) =>
        refs.map(() => ({ problem: 'unreachable' })),
      )
      await service.observeSettledTool({
        sessionId: 'session-1',
        output: `${REF.url}\n`,
        startedAt: CREATED_AT - 5_000,
      })
      expect(listed(database) ?? []).toEqual([])
    })
  })

  it('refuses a new link no write names a source for', async () => {
    const { database } = await harness()
    const events = createPersistentEventService(database, () => undefined)
    const event = ProofEventSchemas['session.updated'].parse({
      type: 'event',
      name: 'session.updated',
      eventId: 'e-1',
      timestamp: '2026-11-10T10:00:00.000Z',
      scope: { type: 'environment', environmentId: 'environment-1' },
      payload: {
        sessionId: 'session-1',
        pullRequests: [
          {
            url: REF.url,
            repository: REF.repository,
            number: 298,
            linkedAt: '2026-11-10T10:00:00.000Z',
            title: null,
            state: null,
            labels: [],
            checks: null,
            reviewDecision: null,
            additions: null,
            deletions: null,
            updatedAt: null,
            syncedAt: null,
            problem: null,
          },
        ],
      },
    })
    expect(() => events.appendAtomic([event])).toThrow(/names no source/)
    events.close()
  })
})

describe('pull_request.get and polling', () => {
  const get = (service: ReturnType<typeof createPullRequestService>, number = 298) =>
    service.dispatch({
      type: 'command',
      requestId: 'r-1',
      name: 'pull_request.get',
      payload: { sessionId: 'session-1', repository: REF.repository, number },
    } as never)

  it('answers the linked pull request in full, and nothing else', async () => {
    const { call, service } = await harness()
    await call(REF.url)
    const answer = (await get(service)) as { payload: { pullRequest: PullRequestRead } }
    expect(answer.payload.pullRequest).toMatchObject({
      number: 298,
      body: '## Summary\nSearch.',
      checkRuns: expect.arrayContaining([expect.objectContaining({ name: 'test' })]),
    })
    await expect(get(service, 1)).resolves.toMatchObject({
      type: 'error',
      error: { code: 'not_found' },
    })
    expect(service.dispatch({ name: 'search.messages' } as never)).toBeUndefined()
  })

  it('publishes only what changed, and stops polling a merged pull request', async () => {
    let state: PullRequestRead['state'] = 'open'
    const { call, service, published, github } = await harness((refs) =>
      refs.map(() => ({ read: { ...READ, state } })),
    )
    await call(REF.url)
    const before = published.length
    // Nothing new: read, but nothing written to the log.
    await service.refresh([REF])
    expect(published.length).toBe(before)
    state = 'merged'
    await service.refresh([REF])
    expect(published.length).toBe(before + 1)
    const reads = vi.mocked(github.read).mock.calls.length
    await service.pollOnce()
    expect(vi.mocked(github.read).mock.calls.length).toBe(reads)
  })

  it('keeps a change it could not publish out of its copy, and publishes it next poll', async () => {
    let state: PullRequestRead['state'] = 'open'
    let at = Date.parse('2026-11-10T10:00:00Z')
    let failing = false
    const { call, service, published, database } = await harness(
      (refs) => refs.map(() => ({ read: { ...READ, state } })),
      { now: () => at, failWrites: () => failing },
    )
    await call(REF.url)
    const copy = () =>
      database.prepare('SELECT state, attempted_at FROM pull_requests').get() as {
        state: string
        attempted_at: number
      }
    const before = published.length
    // Merged on GitHub, and the write that would say so fails.
    state = 'merged'
    failing = true
    at += 60_000
    await service.pollOnce()
    expect(published.length).toBe(before)
    // The copy still says what clients were told; only the pace moved.
    expect(copy()).toEqual({ state: 'open', attempted_at: at })
    expect(listed(database)?.[0]?.state).toBe('open')
    // The next poll finds the change again, and this time it lands.
    failing = false
    at += 60_000
    await service.pollOnce()
    expect(published.length).toBe(before + 1)
    expect(copy().state).toBe('merged')
    expect(listed(database)?.[0]?.state).toBe('merged')
  })
})

describe('the MCP endpoint', () => {
  it('serves the tools to a granted session and refuses everyone else', async () => {
    const { startServer } = await import('../src/server.js')
    const directory = await mkdtemp(join(tmpdir(), 'openmanager-mcp-test-'))
    directories.push(directory)
    const server = await startServer({
      port: 0,
      dataDir: directory,
      logLevel: 'silent',
      github: { read: async (refs) => refs.map(() => ({ problem: 'not_found' as const })) },
    })
    try {
      const grant = server.agentTools.host.openRemote!({ threadId: 'nobody', providerId: 'cursor' })
      const post = (body: unknown, headers: Record<string, string> = grant.http.headers) =>
        fetch(grant.http.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            ...headers,
          },
          body: JSON.stringify(body),
        })
      const initialize = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test', version: '1' },
        },
      }
      expect((await post(initialize, {})).status).toBe(401)
      expect((await post(initialize, { Authorization: 'Bearer guessed' })).status).toBe(401)
      expect((await post(initialize)).status).toBe(200)
      const listed = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
      const tools = ((await listed.json()) as { result: { tools: { name: string }[] } }).result
        .tools
      expect(tools.map((tool) => tool.name)).toEqual(['link_pull_request'])
      const called = await post({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'link_pull_request', arguments: { url: 'not a url' } },
      })
      const result = ((await called.json()) as { result: { isError: boolean } }).result
      expect(result.isError).toBe(true)
      // The stdio bridge an agent without HTTP MCP launches: the same endpoint, line by line.
      const { runMcpBridge } = await import('../src/mcp-bridge.js')
      const { PassThrough } = await import('node:stream')
      const input = new PassThrough()
      const output = new PassThrough()
      let written = ''
      output.on('data', (chunk) => (written += String(chunk)))
      const bridged = runMcpBridge(
        Object.fromEntries(Object.entries(grant.stdio.env)),
        input,
        output,
      )
      input.end(
        [initialize, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }]
          .map((message) => `${JSON.stringify(message)}\n`)
          .join(''),
      )
      await expect(bridged).resolves.toBe(0)
      const lines = written
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { id: number })
      expect(lines.map((line) => line.id).sort()).toEqual([1, 2])
      expect(grant.stdio.args.at(-1)).toBe('mcp-bridge')
      grant.close()
      expect((await post(initialize)).status).toBe(401)
    } finally {
      await server.close()
    }
    // A whole server starts and stops: as slow as the other integration tests under load.
  }, 30_000)
})
