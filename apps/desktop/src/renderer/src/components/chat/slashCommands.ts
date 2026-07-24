/**
 * Slash-command completion for the composer.
 *
 * Both Cursor and OpenCode execute commands as ordinary prompt text (`/name args`)
 * — there is no invocation RPC — so this is pure client-side autocomplete over the
 * provider's `available_commands_update` list.
 */

/** Structural shape shared by runtime `availableCommands` and chrome `slashCommands`. */
export type SlashCommandItem = {
  name: string
  description: string
}

/**
 * The command name being typed, or null when the draft is not in slash context.
 *
 * Only a bare `/name` spanning the whole draft counts: providers parse the command
 * at the start of the prompt, and once the user types a space they are writing
 * arguments, so the picker gets out of the way.
 */
export function slashQueryFromText(text: string): string | null {
  const match = /^\/([\w-]*)$/.exec(text)
  return match ? match[1].toLowerCase() : null
}

/**
 * Commands whose name contains `query`, prefix matches first so typing narrows
 * predictably, then alphabetical. An empty query lists everything.
 */
export function matchSlashCommands(
  commands: readonly SlashCommandItem[],
  query: string,
): SlashCommandItem[] {
  const normalized = query.toLowerCase()
  return commands
    .filter((command) => command.name.toLowerCase().includes(normalized))
    .sort((a, b) => {
      const aPrefix = a.name.toLowerCase().startsWith(normalized)
      const bPrefix = b.name.toLowerCase().startsWith(normalized)
      if (aPrefix !== bPrefix) return aPrefix ? -1 : 1
      return a.name.localeCompare(b.name)
    })
}

/**
 * Draft text that accepts `command`. The trailing space both separates arguments
 * and drops the draft out of slash context, which closes the picker.
 */
export function applySlashCommand(command: SlashCommandItem): string {
  return `/${command.name} `
}
