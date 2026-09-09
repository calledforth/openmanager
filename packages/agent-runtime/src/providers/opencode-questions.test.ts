import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import {
  OpenCodeQuestions,
  openCodeAnswers,
  parseOpenCodeQuestionEvent,
} from './opencode-questions.js'

describe('OpenCode native questions', () => {
  const event = {
    directory: 'C:/workspace',
    payload: {
      type: 'question.asked',
      properties: {
        id: 'request-1',
        sessionID: 'session-1',
        questions: [
          {
            header: 'Strategy',
            question: 'Which implementation should we use?',
            options: [
              { label: 'Simple', description: 'Smallest implementation' },
              { label: 'Robust', description: 'Handles every edge case' },
            ],
            multiple: true,
            custom: true,
          },
        ],
      },
    },
  }

  it('maps question.asked into the provider-neutral contract', () => {
    expect(parseOpenCodeQuestionEvent(event)?.request).toEqual({
      requestId: 'request-1',
      sessionId: 'session-1',
      title: 'Strategy',
      questions: [
        {
          questionId: 'q0',
          prompt: 'Which implementation should we use?',
          options: [
            {
              optionId: 'o0',
              label: 'Simple',
              description: 'Smallest implementation',
            },
            {
              optionId: 'o1',
              label: 'Robust',
              description: 'Handles every edge case',
            },
          ],
          allowMultiple: true,
          allowFreeText: true,
        },
      ],
    })
  })

  it('maps option ids and custom text back to ordered OpenCode answers', () => {
    const parsed = parseOpenCodeQuestionEvent(event)!
    expect(
      openCodeAnswers(
        {
          outcome: 'answered',
          answers: [
            {
              questionId: 'q0',
              selectedOptionIds: ['o1'],
              text: 'A staged version',
            },
          ],
        },
        parsed.nativeQuestions,
      ),
    ).toEqual([['Robust', 'A staged version']])
  })

  it('maps cancellation to OpenCode rejection', () => {
    const parsed = parseOpenCodeQuestionEvent(event)!
    expect(
      openCodeAnswers({ outcome: 'cancelled', reason: 'user' }, parsed.nativeQuestions),
    ).toBeUndefined()
  })

  it('round-trips ask and reply over loopback HTTP with no window', async () => {
    const questions = await OpenCodeQuestions.create()
    const companion = await listenAsOpenCodeCompanion(questions.port)
    try {
      expect(questions.spawnArgs(['acp'])).toEqual([
        'acp',
        '--hostname',
        '127.0.0.1',
        '--port',
        String(questions.port),
      ])

      const seen: Array<{ requestId: string; sessionId: string }> = []
      const streamErrors: unknown[] = []
      questions.start(
        (request) => seen.push(request),
        (error) => {
          streamErrors.push(error)
        },
      )
      await companion.connected
      await vi.waitFor(() => {
        companion.emit(event)
        expect(seen[0]?.requestId).toBe('request-1')
      })
      expect(seen[0]).toMatchObject({ requestId: 'request-1', sessionId: 'session-1' })

      await questions.respond('request-1', {
        outcome: 'answered',
        answers: [{ questionId: 'q0', selectedOptionIds: ['o1'], text: 'A staged version' }],
      })
      await vi.waitFor(() => expect(companion.replies).toHaveLength(1))
      expect(companion.replies[0]).toMatchObject({
        path: '/question/request-1/reply',
        body: { answers: [['Robust', 'A staged version']] },
      })
      expect(streamErrors).toEqual([])
    } finally {
      questions.dispose()
      await companion.close()
    }
  })
})

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk) => chunks.push(chunk as Buffer))
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

async function listenAsOpenCodeCompanion(port: number) {
  let events: ServerResponse | undefined
  let resolveConnected: () => void
  const connected = new Promise<void>((resolve) => {
    resolveConnected = resolve
  })
  const replies: Array<{ path: string; body: unknown }> = []

  const server = createServer((request, response) => {
    const path = request.url?.split('?')[0] ?? ''
    if (request.method === 'GET' && path === '/global/event') {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      events = response
      resolveConnected()
      return
    }
    if (request.method === 'POST' && /\/question\/[^/]+\/(reply|reject)$/.test(path)) {
      void readBody(request).then((raw) => {
        replies.push({ path, body: raw ? JSON.parse(raw) : undefined })
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('{}')
      })
      return
    }
    response.writeHead(404)
    response.end()
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })

  return {
    connected,
    replies,
    emit(payload: unknown) {
      events?.write(`data: ${JSON.stringify(payload)}\n\n`)
    },
    close() {
      events?.end()
      return new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    },
  }
}
