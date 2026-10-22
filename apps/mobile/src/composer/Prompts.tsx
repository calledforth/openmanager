import { ArrowLeftIcon, ArrowRightIcon, CheckIcon, PlayIcon } from 'phosphor-react-native'
import { TextInput, View } from 'react-native'

import { AppText } from '../components/ui/AppText'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { tap } from '../ui/haptics'
import { Press } from '../ui/Press'
import { draftFor, summarizeAnswer } from '@openmanager/app-core/logic'
import type { ComposerPrompt, ChoiceTone } from './model'

type PermissionPromptModel = Extract<ComposerPrompt, { kind: 'permission' }>
type QuestionPromptModel = Extract<ComposerPrompt, { kind: 'question' }>
type PlanPromptModel = Extract<ComposerPrompt, { kind: 'plan' }>

/** A failure under the prompt, in the error tone. */
function PromptError({ text }: { text: string | null }) {
  const theme = usePhoneTheme()
  if (!text) return null
  return (
    <AppText variant="text-12-regular" style={{ color: theme.status.error }}>
      {text}
    </AppText>
  )
}

/** One answer: a fill, the first allow in the action colours, the lasting one a step up. */
function Choice({
  label,
  tone,
  disabled,
  onPress,
}: {
  label: string
  tone: ChoiceTone
  disabled?: boolean
  onPress: () => void
}) {
  const theme = usePhoneTheme()
  const fill =
    tone === 'primary' ? theme.actionBg : tone === 'secondary' ? theme.active : theme.hover
  const ink = tone === 'primary' ? theme.actionFg : tone === 'secondary' ? theme.fg : theme.muted
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={() => {
        tap()
        onPress()
      }}
      style={({ pressed }) => ({
        flexGrow: 1,
        flexBasis: '30%',
        minHeight: 40,
        paddingVertical: 9,
        paddingHorizontal: 10,
        borderRadius: 14,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: fill,
        opacity: disabled ? 0.5 : pressed ? 0.8 : 1,
      })}
    >
      <AppText variant="text-14-medium" numberOfLines={1} style={{ color: ink }}>
        {label}
      </AppText>
    </Press>
  )
}

/**
 * A permission, as the composer becomes it: what the tool wants to do, then
 * the provider's own choices in the order it gave them. With none, there is
 * nothing the phone can answer with, and it says so.
 */
export function PermissionPrompt({ prompt }: { prompt: PermissionPromptModel }) {
  const theme = usePhoneTheme()
  return (
    <View style={{ gap: 10, paddingTop: 6, paddingHorizontal: 6, paddingBottom: 2 }}>
      <View style={{ gap: 2 }}>
        {prompt.detail ? (
          <AppText variant="text-11-medium" style={{ color: theme.status.needs }}>
            {prompt.detail}
          </AppText>
        ) : null}
        <AppText variant="text-14-regular" numberOfLines={4} style={{ color: theme.fg }}>
          {prompt.title}
        </AppText>
      </View>
      {prompt.choices.length > 0 ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {prompt.choices.map((choice) => (
            <Choice
              key={choice.optionId}
              label={choice.label}
              tone={choice.tone}
              disabled={prompt.answering}
              onPress={() => prompt.answer(choice.optionId)}
            />
          ))}
        </View>
      ) : (
        <AppText variant="text-12-regular" style={{ color: theme.muted }}>
          This request offers no answers the phone can give. Answer it on your computer.
        </AppText>
      )}
      <PromptError text={prompt.error} />
    </View>
  )
}

/** A footer action of the question card: Back, Skip, Next, Submit. */
function FlowButton({
  label,
  icon,
  strong,
  disabled,
  onPress,
}: {
  label: string
  icon: 'back' | 'forward' | 'done'
  strong?: boolean
  disabled?: boolean
  onPress: () => void
}) {
  const theme = usePhoneTheme()
  const ink = strong ? theme.actionFg : theme.muted
  const Icon = icon === 'back' ? ArrowLeftIcon : icon === 'done' ? CheckIcon : ArrowRightIcon
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={() => {
        tap()
        onPress()
      }}
      style={({ pressed }) => ({
        flexDirection: icon === 'back' ? 'row' : 'row-reverse',
        alignItems: 'center',
        gap: 6,
        paddingVertical: 8,
        paddingHorizontal: 14,
        borderRadius: 999,
        backgroundColor: strong ? theme.actionBg : pressed ? theme.active : theme.hover,
        opacity: disabled ? 0.45 : 1,
      })}
    >
      <Icon size={13} color={ink} weight="bold" />
      <AppText variant="text-13-medium" style={{ color: ink }}>
        {label}
      </AppText>
    </Press>
  )
}

/**
 * A question, through the shared question flow: one slide per question
 * (its options as fills, more than one where it allows that, a line of your
 * own where it allows that), a review slide when there are several, and
 * Skip until something is answered.
 */
export function QuestionPrompt({ prompt }: { prompt: QuestionPromptModel }) {
  const theme = usePhoneTheme()
  const { flow } = prompt
  const { question, questions, index, onReview, lastIndex } = flow
  const draft = question ? draftFor(flow.drafts, question.questionId) : null
  const freeText = !!question && question.allowFreeText !== false
  return (
    <View style={{ gap: 10, paddingTop: 6, paddingHorizontal: 6, paddingBottom: 2 }}>
      <View style={{ gap: 2 }}>
        <AppText variant="text-11-medium" style={{ color: theme.status.question }}>
          {onReview
            ? 'Review answers'
            : questions.length > 1
              ? `Question ${index + 1} of ${questions.length}`
              : (prompt.title ?? 'Question')}
        </AppText>
        {question ? (
          <AppText variant="text-14-medium" style={{ color: theme.fg }}>
            {question.prompt}
          </AppText>
        ) : null}
      </View>

      {onReview ? (
        <View style={{ gap: 4 }}>
          {questions.map((item, position) => {
            const summary = summarizeAnswer(item, draftFor(flow.drafts, item.questionId))
            return (
              <Press
                key={item.questionId}
                accessibilityRole="button"
                accessibilityLabel={`${item.prompt}: ${summary ?? 'not answered yet'}`}
                onPress={() => flow.goTo(position)}
                style={({ pressed }) => ({
                  paddingVertical: 8,
                  paddingHorizontal: 12,
                  borderRadius: 12,
                  backgroundColor: pressed ? theme.active : theme.hover,
                })}
              >
                <AppText variant="text-12-regular" numberOfLines={1} style={{ color: theme.muted }}>
                  {item.prompt}
                </AppText>
                <AppText
                  variant="text-14-regular"
                  numberOfLines={2}
                  style={{ color: summary ? theme.fg : theme.faint }}
                >
                  {summary ?? 'Not answered yet'}
                </AppText>
              </Press>
            )
          })}
        </View>
      ) : question && draft ? (
        <View style={{ gap: 6 }}>
          {question.options.map((option) => {
            const selected = draft.selectedOptionIds.includes(option.optionId)
            return (
              <Press
                key={option.optionId}
                accessibilityRole={question.allowMultiple ? 'checkbox' : 'radio'}
                accessibilityLabel={option.label || option.optionId}
                accessibilityState={{ checked: selected }}
                onPress={() => {
                  tap()
                  flow.pick(question, option.optionId)
                }}
                style={({ pressed }) => ({
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 10,
                  minHeight: 40,
                  paddingVertical: 8,
                  paddingHorizontal: 12,
                  borderRadius: 14,
                  backgroundColor: selected || pressed ? theme.active : theme.hover,
                })}
              >
                <View style={{ flex: 1, minWidth: 0 }}>
                  <AppText variant="text-14-regular" style={{ color: theme.fg }}>
                    {option.label || option.optionId}
                  </AppText>
                  {option.description ? (
                    <AppText variant="text-12-regular" style={{ color: theme.muted }}>
                      {option.description}
                    </AppText>
                  ) : null}
                </View>
                {question.allowMultiple ? (
                  <View
                    style={{
                      width: 18,
                      height: 18,
                      borderRadius: 5,
                      alignItems: 'center',
                      justifyContent: 'center',
                      backgroundColor: selected ? theme.fg : theme.active,
                    }}
                  >
                    {selected ? <CheckIcon size={12} color={theme.bg} weight="bold" /> : null}
                  </View>
                ) : selected ? (
                  <CheckIcon size={16} color={theme.fg} weight="bold" />
                ) : null}
              </Press>
            )
          })}
          {freeText ? (
            <TextInput
              accessibilityLabel="Another answer"
              value={flow.text}
              onChangeText={flow.setText}
              placeholder="Another answer…"
              placeholderTextColor={theme.faint}
              multiline
              style={{
                minHeight: 40,
                maxHeight: 110,
                paddingVertical: 9,
                paddingHorizontal: 12,
                borderRadius: 14,
                backgroundColor: theme.hover,
                color: theme.fg,
                fontFamily: 'Geist-Regular',
                fontSize: 14,
              }}
            />
          ) : null}
        </View>
      ) : null}

      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        {index > 0 ? (
          <FlowButton label="Back" icon="back" onPress={() => flow.goTo(index - 1)} />
        ) : (
          <View />
        )}
        {flow.canAdvance ? (
          <FlowButton
            strong
            label={index === lastIndex ? (flow.submitting ? 'Sending…' : 'Submit') : 'Next'}
            icon={index === lastIndex ? 'done' : 'forward'}
            disabled={flow.submitting}
            onPress={flow.advance}
          />
        ) : (
          <FlowButton label="Skip" icon="forward" disabled={flow.submitting} onPress={flow.skip} />
        )}
      </View>
      <PromptError text={prompt.error} />
    </View>
  )
}

/**
 * A plan waiting for review, above the composer: its name and overview,
 * Read for the whole document, and Build, which accepts it and starts the
 * build in the mode the plan's provider builds in. The field under it asks
 * for changes instead.
 */
export function PlanPrompt({ prompt, onRead }: { prompt: PlanPromptModel; onRead: () => void }) {
  const theme = usePhoneTheme()
  const { plan } = prompt
  const todos =
    plan.todos.length + (plan.phases?.reduce((n, phase) => n + phase.todos.length, 0) ?? 0)
  return (
    <View style={{ gap: 8, paddingTop: 6, paddingHorizontal: 6 }}>
      <Press
        accessibilityRole="button"
        accessibilityLabel={`Read the plan: ${plan.name || 'Untitled plan'}`}
        onPress={() => {
          tap()
          onRead()
        }}
        style={({ pressed }) => ({
          gap: 2,
          paddingVertical: 8,
          paddingHorizontal: 12,
          borderRadius: 14,
          backgroundColor: pressed ? theme.active : theme.hover,
        })}
      >
        <AppText variant="text-11-medium" style={{ color: theme.status.needs }}>
          {todos > 0 ? `Plan · ${todos} to-dos` : 'Plan'}
        </AppText>
        <AppText variant="text-14-medium" numberOfLines={1} style={{ color: theme.fg }}>
          {plan.name || 'Untitled plan'}
        </AppText>
        {plan.overview ? (
          <AppText variant="text-12-regular" numberOfLines={2} style={{ color: theme.muted }}>
            {plan.overview}
          </AppText>
        ) : null}
      </Press>
      <View style={{ flexDirection: 'row', gap: 6 }}>
        <Press
          accessibilityRole="button"
          accessibilityLabel={
            prompt.buildModeLabel ? `Build in ${prompt.buildModeLabel}` : 'Build the plan'
          }
          accessibilityState={{ disabled: prompt.building, busy: prompt.building }}
          disabled={prompt.building}
          onPress={() => {
            tap()
            prompt.build()
          }}
          style={({ pressed }) => ({
            flex: 1,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            minHeight: 40,
            borderRadius: 14,
            backgroundColor: theme.actionBg,
            opacity: prompt.building ? 0.55 : pressed ? 0.85 : 1,
          })}
        >
          <PlayIcon size={13} color={theme.actionFg} weight="fill" />
          <AppText variant="text-14-medium" style={{ color: theme.actionFg }}>
            {prompt.building
              ? 'Building…'
              : prompt.buildModeLabel
                ? `Build in ${prompt.buildModeLabel}`
                : 'Build'}
          </AppText>
        </Press>
      </View>
      <PromptError text={prompt.error} />
    </View>
  )
}
