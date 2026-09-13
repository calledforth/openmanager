/** Who issued a command, threaded from the socket to every service so refusals can be audited. */
export interface CommandContext {
  readonly clientId: string
  readonly command: string
}
