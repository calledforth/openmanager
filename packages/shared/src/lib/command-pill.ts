/**
 * Turns a shell command into the few tokens worth showing in a transcript row.
 * The full command always stays available for the expanded terminal view, so
 * anything ambiguous here is dropped rather than guessed at.
 */
export interface CommandPillModel {
  label: string
  flags: string[]
  hiddenFlagCount: number
  extraSegmentCount: number
}

export const COMMAND_PILL_FLAG_LIMIT = 3

/** Wrappers whose first positional token is really part of the command name. */
const SUBCOMMAND_WRAPPERS = new Set([
  'git',
  'npm',
  'npx',
  'pnpm',
  'pnpx',
  'yarn',
  'bun',
  'bunx',
  'deno',
  'cargo',
  'go',
  'docker',
  'kubectl',
  'brew',
  'apt',
  'apt-get',
  'uv',
  'uvx',
  'pip',
  'pip3',
  'poetry',
  'gh',
  'dotnet',
  'terraform',
  'systemctl',
])

/** Prefixes that carry no meaning on their own. */
const TRANSPARENT_PREFIXES = new Set(['sudo', 'command', 'time', 'env', 'exec', 'nohup'])

function splitSegments(command: string): string[] {
  const segments: string[] = []
  let start = 0
  let quote: "'" | '"' | null = null
  let escaped = false
  let inBackticks = false
  let substitutionDepth = 0

  const pushSegment = (end: number) => {
    const segment = command.slice(start, end).trim()
    if (segment) segments.push(segment)
  }

  for (let index = 0; index < command.length; index++) {
    const character = command[index]

    if (escaped) {
      escaped = false
      continue
    }
    if (character === '\\' && quote !== "'") {
      escaped = true
      continue
    }
    if (inBackticks) {
      if (character === '`') inBackticks = false
      continue
    }
    if (quote) {
      if (character === quote) quote = null
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      continue
    }
    if (character === '`') {
      inBackticks = true
      continue
    }
    if (character === '$' && command[index + 1] === '(') {
      substitutionDepth++
      index++
      continue
    }
    if (substitutionDepth > 0) {
      if (character === '(') substitutionDepth++
      if (character === ')') substitutionDepth--
      continue
    }

    // Heredoc payloads are data rather than additional shell commands. A
    // compact summary cannot safely parse their delimiter without becoming a
    // shell parser, so omit the segment count for the whole command.
    if (
      character === '<' &&
      command[index - 1] !== '<' &&
      command[index + 1] === '<' &&
      command[index + 2] !== '<'
    ) {
      return command.trim() ? [command.trim()] : []
    }

    const separatorLength =
      character === '\n' || character === ';' || character === '|'
        ? command[index + 1] === '|' && character === '|'
          ? 2
          : 1
        : character === '&'
          ? command[index + 1] === '&'
            ? 2
            : command[index - 1] === '>' || command[index - 1] === '<' || command[index + 1] === '>'
              ? 0
              : 1
          : 0

    if (separatorLength > 0) {
      pushSegment(index)
      index += separatorLength - 1
      start = index + 1
    }
  }

  pushSegment(command.length)
  return segments
}

/** Splits on top-level whitespace while keeping shell expressions together. */
function tokenize(segment: string): string[] {
  const tokens: string[] = []
  let token = ''
  let quote: "'" | '"' | '`' | null = null
  let escaped = false
  let substitutionDepth = 0

  const pushToken = () => {
    if (token) tokens.push(token)
    token = ''
  }

  for (let index = 0; index < segment.length; index++) {
    const character = segment[index]

    if (escaped) {
      token += character
      escaped = false
      continue
    }
    if (character === '\\' && quote !== "'") {
      token += character
      escaped = true
      continue
    }
    if (quote) {
      token += character
      if (character === quote) quote = null
      continue
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character
      token += character
      continue
    }
    if (character === '$' && segment[index + 1] === '(') {
      substitutionDepth++
      token += '$('
      index++
      continue
    }
    if (substitutionDepth > 0) {
      token += character
      if (character === '(') substitutionDepth++
      if (character === ')') substitutionDepth--
      continue
    }
    if (/\s/.test(character)) {
      pushToken()
      continue
    }
    token += character
  }

  pushToken()
  return tokens
}

function isFlag(token: string): boolean {
  return /^--?[^-\s]/.test(token)
}

function isAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)
}

function flagName(token: string): string {
  const equals = token.indexOf('=')
  return equals === -1 ? token : token.slice(0, equals)
}

function isPlainWord(token: string | undefined): boolean {
  return !!token && /^[A-Za-z][\w-]*$/.test(token)
}

export function parseCommandPill(rawCommand: string): CommandPillModel {
  const command = rawCommand.trim()
  if (!command) {
    return { label: '', flags: [], hiddenFlagCount: 0, extraSegmentCount: 0 }
  }

  const segments = splitSegments(command)
  const primary = segments[0] ?? command
  const tokens = tokenize(primary)

  let index = 0
  while (index < tokens.length) {
    if (isAssignment(tokens[index])) {
      index++
      continue
    }
    if (!TRANSPARENT_PREFIXES.has(tokens[index])) break

    const prefixIndex = index
    index++
    if (tokens[index] === '--') index++
    if (isFlag(tokens[index] ?? '')) {
      index = prefixIndex
      break
    }
  }

  const head = tokens[index]
  if (!head) {
    return {
      label: primary,
      flags: [],
      hiddenFlagCount: 0,
      extraSegmentCount: Math.max(0, segments.length - 1),
    }
  }

  const parts = [head]
  index++

  if (SUBCOMMAND_WRAPPERS.has(head) && isPlainWord(tokens[index])) {
    parts.push(tokens[index])
    index++
    // `npm run build`, `cargo run --release`: the script name is the useful bit.
    if ((parts[1] === 'run' || parts[1] === 'exec') && isPlainWord(tokens[index])) {
      parts.push(tokens[index])
      index++
    }
  }

  const seen = new Set<string>()
  const flags: string[] = []
  for (const token of tokens.slice(index)) {
    if (!isFlag(token)) continue
    const name = flagName(token)
    if (seen.has(name)) continue
    seen.add(name)
    flags.push(name)
  }

  return {
    label: parts.join(' '),
    flags: flags.slice(0, COMMAND_PILL_FLAG_LIMIT),
    hiddenFlagCount: Math.max(0, flags.length - COMMAND_PILL_FLAG_LIMIT),
    extraSegmentCount: Math.max(0, segments.length - 1),
  }
}
