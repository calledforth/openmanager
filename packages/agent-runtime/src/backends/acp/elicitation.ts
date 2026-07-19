import type * as acp from '@agentclientprotocol/sdk'
import type { Question, QuestionAnswer, QuestionOutcome } from '@agentpack/contract'

type RecordValue = Record<string, unknown>
type FormProperty = {
  id: string
  required: boolean
  schema: RecordValue
  question: Question
}

export type AcpFormQuestionAdapter = {
  title: string
  questions: Question[]
  respond: (outcome: QuestionOutcome) => acp.CreateElicitationResponse
}

const object = (value: unknown): RecordValue =>
  value && typeof value === 'object' ? (value as RecordValue) : {}
const string = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined
const number = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

function enumOptions(schema: RecordValue): Question['options'] | undefined {
  if (Array.isArray(schema.oneOf)) {
    const options = schema.oneOf.flatMap((raw) => {
      const option = object(raw)
      const optionId = string(option.const)
      if (optionId === undefined) return []
      return [
        {
          optionId,
          label: string(option.title) ?? optionId,
          description: string(option.description),
        },
      ]
    })
    if (options.length > 0) return options
  }
  if (Array.isArray(schema.enum)) {
    const options = schema.enum.flatMap((value) =>
      typeof value === 'string' ? [{ optionId: value, label: value }] : [],
    )
    if (options.length > 0) return options
  }
  return undefined
}

function multiSelectOptions(schema: RecordValue): Question['options'] | undefined {
  const items = object(schema.items)
  if (Array.isArray(items.anyOf)) {
    const options = items.anyOf.flatMap((raw) => {
      const option = object(raw)
      const optionId = string(option.const)
      if (optionId === undefined) return []
      return [
        {
          optionId,
          label: string(option.title) ?? optionId,
          description: string(option.description),
        },
      ]
    })
    if (options.length > 0) return options
  }
  return enumOptions(items)
}

function propertyQuestion(id: string, schema: RecordValue): Question | undefined {
  const type = string(schema.type)
  const label = string(schema.title) ?? id
  const description = string(schema.description)
  const prompt = description ? `${label}\n${description}` : label

  if (type === 'string') {
    const options = enumOptions(schema)
    return {
      questionId: id,
      prompt,
      options: options ?? [],
      allowFreeText: !options,
    }
  }
  if (type === 'number' || type === 'integer') {
    return { questionId: id, prompt, options: [], allowFreeText: true }
  }
  if (type === 'boolean') {
    return {
      questionId: id,
      prompt,
      options: [
        { optionId: 'true', label: 'True' },
        { optionId: 'false', label: 'False' },
      ],
    }
  }
  if (type === 'array') {
    const options = multiSelectOptions(schema)
    if (!options) return undefined
    return { questionId: id, prompt, options, allowMultiple: true }
  }
  return undefined
}

function answerText(answer: QuestionAnswer): string | undefined {
  return answer.text ?? answer.selectedOptionIds?.[0]
}

function validateString(value: string, schema: RecordValue, id: string): string {
  const minLength = number(schema.minLength)
  const maxLength = number(schema.maxLength)
  if (minLength !== undefined && value.length < minLength)
    throw new Error(`Question ${id} must be at least ${minLength} characters`)
  if (maxLength !== undefined && value.length > maxLength)
    throw new Error(`Question ${id} must be at most ${maxLength} characters`)

  const pattern = string(schema.pattern)
  if (pattern) {
    let expression: RegExp
    try {
      expression = new RegExp(pattern)
    } catch {
      throw new Error(`Question ${id} has an invalid validation pattern`)
    }
    if (!expression.test(value)) throw new Error(`Question ${id} does not match its pattern`)
  }

  const format = string(schema.format)
  if (format === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
    throw new Error(`Question ${id} must be an email address`)
  if (format === 'uri') {
    try {
      new URL(value)
    } catch {
      throw new Error(`Question ${id} must be a URI`)
    }
  }
  if (format === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new Error(`Question ${id} must be a date`)
  if (format === 'date-time' && Number.isNaN(Date.parse(value)))
    throw new Error(`Question ${id} must be a date-time`)
  return value
}

function propertyValue(field: FormProperty, answer: QuestionAnswer): acp.ElicitationContentValue {
  const type = string(field.schema.type)
  if (type === 'string') {
    const options = enumOptions(field.schema)
    const value = options ? answer.selectedOptionIds?.[0] : answerText(answer)
    if (value === undefined) throw new Error(`Question ${field.id} has no answer`)
    if (options && !options.some((option) => option.optionId === value))
      throw new Error(`Invalid option for question ${field.id}: ${value}`)
    return validateString(value, field.schema, field.id)
  }
  if (type === 'number' || type === 'integer') {
    const raw = answerText(answer)
    if (raw === undefined || raw.trim() === '')
      throw new Error(`Question ${field.id} has no answer`)
    const value = Number(raw)
    if (!Number.isFinite(value)) throw new Error(`Question ${field.id} must be a number`)
    if (type === 'integer' && !Number.isInteger(value))
      throw new Error(`Question ${field.id} must be an integer`)
    const minimum = number(field.schema.minimum)
    const maximum = number(field.schema.maximum)
    if (minimum !== undefined && value < minimum)
      throw new Error(`Question ${field.id} must be at least ${minimum}`)
    if (maximum !== undefined && value > maximum)
      throw new Error(`Question ${field.id} must be at most ${maximum}`)
    return value
  }
  if (type === 'boolean') {
    const raw = answerText(answer)?.toLowerCase()
    if (raw === 'true') return true
    if (raw === 'false') return false
    throw new Error(`Question ${field.id} must be true or false`)
  }
  if (type === 'array') {
    const values = answer.selectedOptionIds ?? []
    const options = multiSelectOptions(field.schema) ?? []
    const allowed = new Set(options.map((option) => option.optionId))
    for (const value of values) {
      if (!allowed.has(value)) throw new Error(`Invalid option for question ${field.id}: ${value}`)
    }
    const minimum = number(field.schema.minItems)
    const maximum = number(field.schema.maxItems)
    if (minimum !== undefined && values.length < minimum)
      throw new Error(`Question ${field.id} requires at least ${minimum} selections`)
    if (maximum !== undefined && values.length > maximum)
      throw new Error(`Question ${field.id} allows at most ${maximum} selections`)
    return values
  }
  throw new Error(`Unsupported question type for ${field.id}`)
}

function responseFor(
  fields: readonly FormProperty[],
  outcome: QuestionOutcome,
): acp.CreateElicitationResponse {
  if (outcome.outcome === 'cancelled') return { action: 'cancel' }

  const known = new Set(fields.map((field) => field.id))
  const answers = new Map<string, QuestionAnswer>()
  for (const answer of outcome.answers) {
    if (!known.has(answer.questionId))
      throw new Error(`Unknown elicitation question: ${answer.questionId}`)
    if (answers.has(answer.questionId))
      throw new Error(`Duplicate answer for elicitation question: ${answer.questionId}`)
    answers.set(answer.questionId, answer)
  }

  const content: Record<string, acp.ElicitationContentValue> = {}
  for (const field of fields) {
    const answer = answers.get(field.id)
    if (!answer) {
      if (field.required) throw new Error(`Missing answer for required question: ${field.id}`)
      continue
    }
    content[field.id] = propertyValue(field, answer)
  }
  return { action: 'accept', content }
}

/**
 * Converts an ACP form elicitation into the provider-neutral Q&A contract.
 * URL and future modes deliberately return undefined because only form support
 * is advertised during ACP initialization.
 */
export function parseAcpFormElicitation(
  params: acp.CreateElicitationRequest,
): AcpFormQuestionAdapter | undefined {
  const request = object(params)
  if (string(request.mode) !== 'form') return undefined
  const requestedSchema = object(request.requestedSchema)
  const properties = object(requestedSchema.properties)
  const required = new Set(
    Array.isArray(requestedSchema.required)
      ? requestedSchema.required.filter((value): value is string => typeof value === 'string')
      : [],
  )
  const fields: FormProperty[] = []
  for (const [id, rawSchema] of Object.entries(properties)) {
    const schema = object(rawSchema)
    const question = propertyQuestion(id, schema)
    if (!question) return undefined
    fields.push({ id, required: required.has(id), schema, question })
  }
  if (fields.length === 0) return undefined
  return {
    title: string(request.message) ?? string(requestedSchema.title) ?? 'The agent has a question',
    questions: fields.map((field) => field.question),
    respond: (outcome) => responseFor(fields, outcome),
  }
}
