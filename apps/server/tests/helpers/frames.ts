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

/**
 * The next whole message on a socket nothing else reads. One listener stays
 * attached until the message is whole: the fragments of one message can be
 * emitted in the same tick (one TCP read), and re-attaching between them
 * would miss the rest.
 */
export function nextServerText(ws: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    const assembler = new FragmentAssembler()
    const stop = () => {
      ws.off('message', onMessage)
      ws.off('close', onClose)
    }
    const onMessage = (data: Buffer, isBinary: boolean) => {
      let text: string | undefined
      if (!isBinary) {
        text = data.toString()
      } else {
        const whole = assembler.push(new Uint8Array(data))
        if (whole) text = Buffer.from(whole).toString('utf8')
      }
      if (text === undefined) return
      stop()
      resolve(text)
    }
    const onClose = () => {
      stop()
      reject(new Error('the socket closed before a whole message arrived'))
    }
    ws.on('message', onMessage)
    ws.on('close', onClose)
  })
}
