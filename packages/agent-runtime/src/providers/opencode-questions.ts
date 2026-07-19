import { createServer } from 'node:net'
import { createOpencodeClient } from '@opencode-ai/sdk/v2'
import type { Question, QuestionOutcome } from '@agentpack/contract'

type UnknownRecord = Record<string, unknown>

export type OpenCodeQuestionRequest = {
  requestId: string
  sessionId: string
  title?: string
  questions: Question[]
}

type NativeQuestion = {
  question: string
  header: string
  options: Array<{ label: string; description: string }>
  multiple?: boolean
  custom?: boolean
}

const object = (value: unknown): UnknownRecord =>
  value && typeof value === 'object' ? (value as UnknownRecord) : {}
const string = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined

export function parseOpenCodeQuestionEvent(
  event: unknown,
): { request: OpenCodeQuestionRequest; nativeQuestions: NativeQuestion[] } | undefined {
  const payload = object(object(event).payload)
  if (payload.type !== 'question.asked') return undefined
  // OpenCode's stable event API currently calls this field `properties`; newer
  // generated event types call it `data`. Accept both across CLI versions.
  const data = object(payload.properties ?? payload.data)
  const requestId = string(data.id) ?? string(data.requestID)
  const sessionId = string(data.sessionID) ?? string(data.sessionId)
  if (!requestId || !sessionId || !Array.isArray(data.questions)) return undefined
  const nativeQuestions = data.questions.map((value) => {
    const question = object(value)
    return {
      question: string(question.question) ?? '',
      header: string(question.header) ?? '',
      options: (Array.isArray(question.options) ? question.options : []).map((value) => {
        const option = object(value)
        return {
          label: string(option.label) ?? '',
          description: string(option.description) ?? '',
        }
      }),
      multiple: question.multiple === true,
      custom: question.custom !== false,
    }
  })
  if (nativeQuestions.length === 0) return undefined
  return {
    request: {
      requestId,
      sessionId,
      title: nativeQuestions.length === 1 ? nativeQuestions[0].header || undefined : undefined,
      questions: nativeQuestions.map((question, questionIndex) => ({
        questionId: `q${questionIndex}`,
        prompt: question.question,
        options: question.options.map((option, optionIndex) => ({
          optionId: `o${optionIndex}`,
          label: option.label,
          description: option.description || undefined,
        })),
        allowMultiple: question.multiple,
        allowFreeText: question.custom,
      })),
    },
    nativeQuestions,
  }
}

export function openCodeAnswers(
  outcome: QuestionOutcome,
  nativeQuestions: NativeQuestion[],
): string[][] | undefined {
  if (outcome.outcome !== 'answered') return undefined
  return nativeQuestions.map((question, questionIndex) => {
    const answer = outcome.answers.find((answer) => answer.questionId === `q${questionIndex}`)
    const selected = (answer?.selectedOptionIds ?? []).flatMap((optionId) => {
      const match = /^o(\d+)$/.exec(optionId)
      const option = match ? question.options[Number(match[1])] : undefined
      return option?.label ? [option.label] : []
    })
    const text = answer?.text?.trim()
    return text ? [...selected, text] : selected
  })
}

async function availablePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('Could not allocate an OpenCode companion port'))
        return
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)))
    })
  })
}

export class OpenCodeQuestions {
  private readonly client
  private readonly controller = new AbortController()
  private streamTask: Promise<void> | undefined
  private readonly nativeQuestions = new Map<string, NativeQuestion[]>()

  private constructor(readonly port: number) {
    const password = process.env.OPENCODE_SERVER_PASSWORD
    const username = process.env.OPENCODE_SERVER_USERNAME ?? 'opencode'
    this.client = createOpencodeClient({
      baseUrl: `http://127.0.0.1:${port}`,
      ...(password
        ? { headers: { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` } }
        : {}),
    })
  }

  static async create(): Promise<OpenCodeQuestions> {
    return new OpenCodeQuestions(await availablePort())
  }

  spawnArgs(args: readonly string[]): string[] {
    return [...args, '--hostname', '127.0.0.1', '--port', String(this.port)]
  }

  start(
    onQuestion: (request: OpenCodeQuestionRequest) => void,
    onError: (error: unknown) => void,
  ): void {
    if (this.streamTask) return
    this.streamTask = this.consume(onQuestion).catch((error) => {
      if (!this.controller.signal.aborted) onError(error)
    })
  }

  private async consume(onQuestion: (request: OpenCodeQuestionRequest) => void): Promise<void> {
    const result = await this.client.global.event({ signal: this.controller.signal })
    for await (const event of result.stream) {
      const parsed = parseOpenCodeQuestionEvent(event)
      if (!parsed || this.nativeQuestions.has(parsed.request.requestId)) continue
      this.nativeQuestions.set(parsed.request.requestId, parsed.nativeQuestions)
      onQuestion(parsed.request)
    }
  }

  async respond(requestId: string, outcome: QuestionOutcome): Promise<void> {
    const questions = this.nativeQuestions.get(requestId)
    if (!questions) throw new Error(`Unknown OpenCode question request: ${requestId}`)
    try {
      const answers = openCodeAnswers(outcome, questions)
      if (answers) {
        await this.client.question.reply(
          { requestID: requestId, answers },
          { throwOnError: true },
        )
      } else {
        await this.client.question.reject({ requestID: requestId }, { throwOnError: true })
      }
    } finally {
      this.nativeQuestions.delete(requestId)
    }
  }

  dispose(): void {
    this.controller.abort()
    this.nativeQuestions.clear()
  }
}
