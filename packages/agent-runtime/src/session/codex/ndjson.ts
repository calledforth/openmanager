import { StringDecoder } from 'node:string_decoder'

/** Splits a byte stream into lines, for `codex app-server`'s newline-delimited
 * JSON.
 *
 * Three things a naive `buffer += chunk; buffer.split('\n')` gets wrong:
 *
 * - **Quadratic buffering.** A large line (a whole file in a tool result, a
 *   long diff) arrives in hundreds of 64 KB chunks. Appending each to one
 *   string and rescanning it from the start costs O(n²) in the line length.
 *   Here the pieces of an unfinished line are only collected, each chunk is
 *   scanned once, and they are joined once, when the newline arrives.
 * - **Split characters.** A chunk boundary can fall inside a multi-byte UTF-8
 *   sequence. `StringDecoder` holds the partial bytes back instead of turning
 *   them into U+FFFD.
 * - **CRLF.** A Windows build may end lines with `\r\n`; the `\r` is dropped.
 *
 * Blank lines are skipped. A line longer than `maxLineChars` is discarded
 * rather than held in memory: one runaway message must not take the host
 * down with it. `onOversize` still gets its first `OVERSIZE_HEAD_CHARS`, so
 * the reader can tell whose message it was (Codex writes `id` and `method`
 * first) and answer it, instead of leaving a request or a waiting caller
 * hanging. */
export const OVERSIZE_HEAD_CHARS = 4096

export class LineDecoder {
  private readonly decoder = new StringDecoder('utf8')
  private pieces: string[] = []
  private pending = 0
  /** Set while discarding the rest of an oversize line. */
  private skipping = false
  /** The start of the line being discarded. */
  private head = ''

  constructor(
    private readonly onLine: (line: string) => void,
    private readonly options: {
      maxLineChars?: number
      onOversize?: (chars: number, head: string) => void
    } = {},
  ) {}

  push(chunk: Buffer | string): void {
    const text = typeof chunk === 'string' ? chunk : this.decoder.write(chunk)
    let start = 0
    for (;;) {
      const newline = text.indexOf('\n', start)
      if (newline === -1) {
        this.collect(text.slice(start))
        return
      }
      this.collect(text.slice(start, newline))
      this.finishLine()
      start = newline + 1
    }
  }

  /** Flush a final line that had no trailing newline, at end of stream. */
  end(): void {
    this.collect(this.decoder.end())
    if (this.pending > 0 || this.skipping) this.finishLine()
  }

  private collect(piece: string): void {
    if (piece.length === 0) return
    if (this.skipping) {
      this.pending += piece.length
      return
    }
    this.pieces.push(piece)
    this.pending += piece.length
    const max = this.options.maxLineChars
    if (max !== undefined && this.pending > max) {
      // Stop holding it; keep counting so the report says how big it got.
      this.head = this.pieces.join('').slice(0, OVERSIZE_HEAD_CHARS)
      this.pieces = []
      this.skipping = true
    }
  }

  private finishLine(): void {
    if (this.skipping) {
      const chars = this.pending
      const head = this.head
      this.skipping = false
      this.pending = 0
      this.head = ''
      this.options.onOversize?.(chars, head)
      return
    }
    let line = this.pieces.length === 1 ? this.pieces[0]! : this.pieces.join('')
    this.pieces = []
    this.pending = 0
    if (line.endsWith('\r')) line = line.slice(0, -1)
    if (line.trim().length === 0) return
    this.onLine(line)
  }
}
