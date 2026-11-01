import { describe, expect, it } from 'vitest'
import { presentToolPart, resolveTool, type ToolPartData } from './tool-presenter'

const done = (fields: ToolPartData, input?: unknown): ToolPartData => ({
  ...fields,
  state: { status: 'completed', ...(input ? { input } : {}) },
})
const line = (part: ToolPartData) => {
  const model = presentToolPart(part)
  return `${model.verb} ${model.detail}`
}

describe('every row reads from its input alone', () => {
  it('Claude Code', () => {
    expect(line(done({ toolName: 'Bash' }, { command: 'pnpm test\n--verbose' }))).toBe(
      'Ran pnpm test',
    )
    expect(line(done({ toolName: 'PowerShell' }, { command: 'dir' }))).toBe('Ran dir')
    expect(line(done({ toolName: 'Read' }, { file_path: 'src/app/index.ts' }))).toBe(
      'Read index.ts',
    )
    expect(line(done({ toolName: 'Edit' }, { file_path: 'a/b.ts' }))).toBe('Edited b.ts')
    expect(line(done({ toolName: 'Write' }, { file_path: 'a/c.ts' }))).toBe('Wrote c.ts')
    expect(
      line(done({ toolName: 'NotebookEdit', kind: 'edit' }, { notebook_path: 'a/n.ipynb' })),
    ).toBe('Edited n.ipynb')
    expect(line(done({ toolName: 'Grep' }, { pattern: 'applyToolUpdate', path: 'packages' }))).toBe(
      'Searched for "applyToolUpdate" in packages',
    )
    expect(line(done({ toolName: 'Glob' }, { pattern: '**/*.ts' }))).toBe('Found **/*.ts')
    expect(line(done({ toolName: 'WebSearch' }, { query: 'cats' }))).toBe(
      'Searched the web for "cats"',
    )
    expect(line(done({ toolName: 'WebFetch' }, { url: 'https://a.example/b' }))).toBe(
      'Fetched https://a.example/b',
    )
    expect(line(done({ toolName: 'Agent' }, { description: 'Audit it' }))).toBe(
      'Ran subagent Audit it',
    )
    expect(line(done({ toolName: 'mcp__claude_ai_Linear__list_issues' }))).toBe(
      'Linear list issues',
    )
  })

  it('Cursor, from the titles it really sends', () => {
    const title = (value: string, kind: string, input?: unknown) =>
      line(done({ title: value, kind }, input))
    expect(title('`git status`', 'execute', { command: 'git status' })).toBe('Ran git status')
    expect(title('Read src\\app\\layout.tsx', 'read')).toBe('Read layout.tsx')
    expect(title('Read src/app/globals.css (1 - 80)', 'read')).toBe('Read globals.css (1 - 80)')
    expect(title('Edit `C:\\work\\top-bar.tsx`', 'edit')).toBe('Edited top-bar.tsx')
    expect(title('Delete `src/old.tsx`', 'delete')).toBe('Deleted old.tsx')
    expect(title('grep --include="*.ts" "mode capabilities"', 'search')).toBe(
      'Searched for "mode capabilities"',
    )
    expect(title('Find `*.txt`', 'search')).toBe('Found *.txt')
    expect(title('Find `docs` `*.md`', 'search')).toBe('Found *.md')
    expect(title("List the `src` directory's contents", 'search')).toBe('Listed src')
    expect(title('Search: "where sessions resume"', 'search')).toBe(
      'Searched for "where sessions resume"',
    )
    expect(title('Web Search: "acp"', 'search')).toBe('Searched the web for "acp"')
    expect(title('Web Fetch: https://a.example', 'fetch')).toBe('Fetched https://a.example')
    expect(title('Task: Summarize', 'other')).toBe('Ran subagent Summarize')
  })

  it("Cursor's generic titles, when a fast model sent nothing else", () => {
    expect(line(done({ title: 'Read File', kind: 'read' }))).toBe('Read File')
    expect(
      line(done({ title: 'Edit File', kind: 'edit', locations: [{ path: 'C:/a/notes.md' }] })),
    ).toBe('Edited notes.md')
    expect(line(done({ title: 'Delete File', kind: 'delete' }))).toBe('Deleted file')
    expect(line(done({ title: 'grep', toolName: 'grep', kind: 'search' }))).toBe(
      'Searched for code',
    )
    expect(line(done({ title: 'Find', kind: 'search' }))).toBe('Found files')
    expect(line(done({ title: 'Terminal', kind: 'execute' }))).toContain('Ran')
    expect(
      line(
        done(
          { title: 'linear: list_issues', kind: 'other' },
          { providerIdentifier: 'linear', toolName: 'list_issues' },
        ),
      ),
    ).toBe('linear list issues')
  })

  it('OpenCode, whose title becomes prose once the name is known', () => {
    const named = (toolName: string, title: string, kind: string, input?: unknown) =>
      line(done({ toolName, title, kind }, input))
    expect(named('bash', 'Runs the tests', 'execute', { command: 'bun test' })).toBe('Ran bun test')
    expect(named('read', 'src/index.ts', 'read', { filePath: 'src/index.ts' })).toBe(
      'Read index.ts',
    )
    expect(named('edit', 'src/index.ts', 'edit', { filePath: 'src/index.ts' })).toBe(
      'Edited index.ts',
    )
    expect(named('grep', 'TODO', 'search', { pattern: 'TODO', path: 'src' })).toBe(
      'Searched for "TODO" in src',
    )
    expect(named('glob', '*.ts', 'search', { pattern: '*.ts' })).toBe('Found *.ts')
    expect(named('list', 'src', 'read', { path: 'src' })).toBe('Listed src')
    expect(named('webfetch', 'x', 'fetch', { url: 'https://a.example' })).toBe(
      'Fetched https://a.example',
    )
    expect(named('task', 'Summarize', 'think', { description: 'Summarize' })).toBe(
      'Ran subagent Summarize',
    )
    expect(
      line(
        done({
          toolName: 'apply_patch',
          title: 'Patched',
          kind: 'edit',
          locations: [{ path: 'src/a.ts' }],
        }),
      ),
    ).toBe('Edited a.ts')
  })
})

describe('what a row adds to the line', () => {
  it('prefers the line counts the provider reported', () => {
    const model = presentToolPart(
      done({ toolName: 'Edit', lineChanges: { added: 3, removed: 1 } }, { path: 'a' }),
    )
    expect(model).toMatchObject({ diffAdds: 3, diffDels: 1 })
  })

  it('names how a call ended, when it did not complete', () => {
    const ended = (status: string) =>
      presentToolPart({ toolName: 'Bash', state: { status } }).outcome
    expect(ended('error')).toBe('failed')
    expect(ended('declined')).toBe('declined')
    expect(ended('cancelled')).toBe('cancelled')
    expect(ended('completed')).toBeUndefined()
  })

  it('says how long a call ran, and lists every file', () => {
    const model = presentToolPart({
      ...done({ toolName: 'Edit', locations: [{ path: 'a.ts' }, { path: 'b.ts' }] }),
      time: { start: 1_000, end: 3_500 },
    })
    expect(model.durationMs).toBe(2_500)
    expect(model.files).toEqual(['a.ts', 'b.ts'])
  })

  it('keeps the whole command for the opened row', () => {
    const model = presentToolPart(done({ toolName: 'Bash' }, { command: 'one\ntwo' }))
    expect(model.detail).toBe('one')
    expect(model.fullDetail).toBe('one\ntwo')
  })
})

describe('resolveTool', () => {
  it('lets a name win over a title', () => {
    expect(resolveTool({ toolName: 'Bash', title: 'Edit `a.ts`', kind: 'edit' }).canonical).toBe(
      'Bash',
    )
  })

  it('leaves a tool it does not know alone', () => {
    expect(resolveTool({ toolName: 'ToolSearch', kind: 'other' }).canonical).toBe('ToolSearch')
  })
})
