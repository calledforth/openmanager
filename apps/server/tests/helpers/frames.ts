import { once } from 'node:events'
import type { WebSocket } from 'ws'
import { FragmentAssembler } from '@openmanager/protocol/node'

/**
 * Read a server socket as a browser would (protocol v19): whole messages,
 * reassembled from binary fragments, each acknowledged so the server's send
 * window never stalls a test.
 */
export function onServerText(ws: WebSocket, listener: (text: string) => void): void {
  const assembler = new FragmentAssembler()
  let received = 0
  ws.on('message', (data: Buffer, isBinary: boolean) => {
    received += data.byteLength
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'ack', received }))
    if (!isBinary) {
      listener(data.toString())
      return
    }
    const whole = assembler.push(new Uint8Array(data))
    if (whole) listener(Buffer.from(whole).toString('utf8'))
  })
}

/** The next whole message on a socket nothing else reads. */
export async function nextServerText(ws: WebSocket): Promise<string> {
  const assembler = new FragmentAssembler()
  for (;;) {
    const [data, isBinary] = (await once(ws, 'message')) as [Buffer, boolean]
    if (!isBinary) return data.toString()
    const whole = assembler.push(new Uint8Array(data))
    if (whole) return Buffer.from(whole).toString('utf8')
  }
}
