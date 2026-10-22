/**
 * A small, fast highlighter for fenced code in the transcript. Web runs Shiki
 * (TextMate grammars over a WASM regex engine), which the phone cannot load;
 * this reads what agent output mostly holds (comments, strings, numbers,
 * keywords) with one pass of plain regular expressions, line by line, so a
 * streamed block is cheap to colour again on every token. Pure: the colours
 * are the theme's, picked by the view.
 */

export type CodeTokenKind = 'plain' | 'comment' | 'string' | 'number' | 'keyword'

export interface CodeToken {
  kind: CodeTokenKind
  text: string
}

type CommentStyle = 'c' | 'hash' | 'sql' | 'none'

interface Grammar {
  comments: CommentStyle
  keywords: ReadonlySet<string>
}

const words = (list: string) => new Set(list.split(/\s+/).filter(Boolean))

const JS = words(`
  abstract as async await break case catch class const continue debugger declare default delete
  do else enum export extends false finally for from function get if implements import in
  instanceof interface keyof let new null of private protected public readonly return satisfies
  set static super switch this throw true try type typeof undefined var void while with yield
`)
const PYTHON = words(`
  and as assert async await break class continue def del elif else except False finally for
  from global if import in is lambda None nonlocal not or pass raise return self True try while
  with yield match case
`)
const RUST = words(`
  as async await break const continue crate dyn else enum extern false fn for if impl in let loop
  match mod move mut pub ref return Self self static struct super trait true type unsafe use where
  while Some None Ok Err
`)
const GO = words(`
  break case chan const continue default defer else fallthrough for func go goto if import
  interface map package range return select struct switch type var nil true false
`)
const C_LIKE = words(`
  auto break case char class const continue default do double else enum extern final float for
  goto if int long new null private protected public return short signed sizeof static struct
  switch this throw true false try typedef union unsigned void volatile while boolean import
  package extends implements
`)
const SHELL = words(`
  if then else elif fi for while until do done case esac in function return export local readonly
  echo cd set unset source exit
`)
const SQL = words(`
  select from where and or not insert into values update set delete create table index view drop
  alter join left right inner outer on group by order having limit offset as distinct null is
  primary key references default union all case when then else end
`)
const NONE = new Set<string>()

const GRAMMARS: Record<string, Grammar> = {
  js: { comments: 'c', keywords: JS },
  python: { comments: 'hash', keywords: PYTHON },
  rust: { comments: 'c', keywords: RUST },
  go: { comments: 'c', keywords: GO },
  c: { comments: 'c', keywords: C_LIKE },
  shell: { comments: 'hash', keywords: SHELL },
  sql: { comments: 'sql', keywords: SQL },
  data: { comments: 'hash', keywords: words('true false null') },
  json: { comments: 'none', keywords: words('true false null') },
  css: { comments: 'c', keywords: NONE },
  plain: { comments: 'none', keywords: NONE },
}

const ALIAS_LIST: Record<string, keyof typeof GRAMMARS> = {
  js: 'js',
  jsx: 'js',
  ts: 'js',
  tsx: 'js',
  javascript: 'js',
  typescript: 'js',
  mjs: 'js',
  cjs: 'js',
  py: 'python',
  python: 'python',
  rs: 'rust',
  rust: 'rust',
  go: 'go',
  golang: 'go',
  c: 'c',
  h: 'c',
  cpp: 'c',
  'c++': 'c',
  java: 'c',
  kotlin: 'c',
  kt: 'c',
  swift: 'c',
  cs: 'c',
  csharp: 'c',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  shell: 'shell',
  console: 'shell',
  powershell: 'shell',
  ps1: 'shell',
  sql: 'sql',
  yaml: 'data',
  yml: 'data',
  toml: 'data',
  ini: 'data',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  css: 'css',
  scss: 'css',
}

// Maps, not plain objects: a fence is named by whatever the model wrote, and
// `constructor` or `__proto__` must not reach an inherited property.
const ALIASES = new Map(Object.entries(ALIAS_LIST))
const GRAMMAR_BY_KEY = new Map(Object.entries(GRAMMARS))
const PLAIN = GRAMMARS.plain!

/** The grammar a fence's info string names; anything unknown is plain text. */
export function grammarOf(info: string | undefined): Grammar {
  const lang = (info ?? '').trim().split(/\s+/)[0]?.toLowerCase() ?? ''
  const key = ALIASES.get(lang)
  return (key !== undefined ? GRAMMAR_BY_KEY.get(key) : undefined) ?? PLAIN
}

/** The language a fence names, for its label; empty when it names none. */
export function languageLabel(info: string | undefined): string {
  return (info ?? '').trim().split(/\s+/)[0] ?? ''
}

const STRING = /^(?:"(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?|`(?:[^`\\]|\\.)*`?)/
const NUMBER = /^(?:0[xX][\da-fA-F_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)\b/
const WORD = /^[A-Za-z_$][\w$]*/
const PLAIN_RUN = /^[^A-Za-z_$\d"'`#/-]+/

function commentAt(line: string, index: number, style: CommentStyle): boolean {
  if (style === 'none') return false
  const ch = line[index]
  if (style === 'hash') return ch === '#'
  if (style === 'sql') return ch === '-' && line[index + 1] === '-'
  return ch === '/' && (line[index + 1] === '/' || line[index + 1] === '*')
}

function push(tokens: CodeToken[], kind: CodeTokenKind, text: string) {
  if (!text) return
  const last = tokens[tokens.length - 1]
  if (last && last.kind === kind) last.text += text
  else tokens.push({ kind, text })
}

/**
 * One line as tokens. `inBlock` says a C-style block comment is open from an
 * earlier line; the result says whether one is still open after this one.
 */
export function highlightLine(
  line: string,
  grammar: Grammar,
  inBlock = false,
): { tokens: CodeToken[]; inBlock: boolean } {
  // Unknown languages stay plain: colouring prose quotes reads as noise.
  if (grammar === GRAMMARS.plain)
    return { tokens: line ? [{ kind: 'plain', text: line }] : [], inBlock }
  const tokens: CodeToken[] = []
  let index = 0
  let open = inBlock
  while (index < line.length) {
    const rest = line.slice(index)
    if (open) {
      const end = rest.indexOf('*/')
      if (end === -1) {
        push(tokens, 'comment', rest)
        index = line.length
      } else {
        push(tokens, 'comment', rest.slice(0, end + 2))
        index += end + 2
        open = false
      }
      continue
    }
    if (commentAt(line, index, grammar.comments)) {
      if (grammar.comments === 'c' && line[index + 1] === '*') {
        open = true
        push(tokens, 'comment', '/*')
        index += 2
        continue
      }
      push(tokens, 'comment', rest)
      break
    }
    const string = STRING.exec(rest)
    if (string) {
      push(tokens, 'string', string[0])
      index += string[0].length
      continue
    }
    const number = NUMBER.exec(rest)
    if (number) {
      push(tokens, 'number', number[0])
      index += number[0].length
      continue
    }
    const word = WORD.exec(rest)
    if (word) {
      push(tokens, grammar.keywords.has(word[0]) ? 'keyword' : 'plain', word[0])
      index += word[0].length
      continue
    }
    const plain = PLAIN_RUN.exec(rest)
    const text = plain ? plain[0] : rest[0]!
    push(tokens, 'plain', text)
    index += text.length
  }
  return { tokens, inBlock: open }
}

/** A whole block, one token list per line. */
export function highlightCode(code: string, info?: string): CodeToken[][] {
  const grammar = grammarOf(info)
  const lines = code.replace(/\n$/, '').split('\n')
  let inBlock = false
  return lines.map((line) => {
    const result = highlightLine(line, grammar, inBlock)
    inBlock = result.inBlock
    return result.tokens
  })
}
