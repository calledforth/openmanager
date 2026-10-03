/** Who issued a command, threaded from the socket to every service so refusals can be audited. */
export interface CommandContext {
  readonly clientId: string
  readonly command: string
  /**
   * Run `task` once this command's answer has been sent. A command that ends
   * the caller's own connection (owner rotation) closes it here, so the
   * answer is not lost to the close.
   */
  readonly afterReply?: (task: () => void) => void
  /**
   * Have this connection receive a live reading from now on, until it closes.
   * The command that asks has already passed its capability check.
   */
  readonly follow?: (topic: string) => void
}
