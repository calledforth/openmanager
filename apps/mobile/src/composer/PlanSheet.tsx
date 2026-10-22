import { CheckCircleIcon, CircleIcon, RadioButtonIcon } from 'phosphor-react-native'
import { ScrollView, useWindowDimensions, View } from 'react-native'
import type { PlanRow } from '@openmanager/app-core/logic'

import { TextPart } from '../components/parts/TextPart'
import { AppText } from '../components/ui/AppText'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { Sheet } from '../ui/Sheet'

type Todo = PlanRow['todos'][number]

function Todos({ todos }: { todos: readonly Todo[] }) {
  const theme = usePhoneTheme()
  return (
    <View style={{ gap: 6 }}>
      {todos.map((todo) => {
        const Icon =
          todo.status === 'completed'
            ? CheckCircleIcon
            : todo.status === 'in_progress'
              ? RadioButtonIcon
              : CircleIcon
        const color =
          todo.status === 'completed'
            ? theme.status.done
            : todo.status === 'in_progress'
              ? theme.fg
              : theme.faint
        return (
          <View key={todo.id} style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-start' }}>
            <View style={{ paddingTop: 2 }}>
              <Icon size={15} color={color} />
            </View>
            <AppText
              variant="text-14-regular"
              style={{
                flex: 1,
                color:
                  todo.status === 'in_progress'
                    ? theme.fg
                    : todo.status === 'cancelled'
                      ? theme.faint
                      : theme.muted,
                textDecorationLine: todo.status === 'cancelled' ? 'line-through' : 'none',
              }}
            >
              {todo.content}
            </AppText>
          </View>
        )
      })}
    </View>
  )
}

/** The whole plan, read from the prompt: overview, the document, its to-dos and phases. */
export function PlanSheet({ plan, onClose }: { plan: PlanRow; onClose: () => void }) {
  const theme = usePhoneTheme()
  const { height } = useWindowDimensions()
  return (
    <Sheet onDismiss={onClose} onBack={onClose}>
      <AppText
        accessibilityRole="header"
        variant="text-16-medium"
        style={{ color: theme.fg, marginBottom: 8, paddingHorizontal: 4 }}
      >
        {plan.name || 'Untitled plan'}
      </AppText>
      <ScrollView style={{ maxHeight: height * 0.62 }}>
        <View style={{ gap: 14, paddingHorizontal: 4, paddingBottom: 8 }}>
          {plan.overview ? (
            <AppText variant="text-14-regular" style={{ color: theme.muted }}>
              {plan.overview}
            </AppText>
          ) : null}
          {plan.markdown ? <TextPart text={plan.markdown} /> : null}
          {plan.todos.length > 0 ? (
            <View style={{ gap: 8 }}>
              <AppText variant="text-11-medium" style={{ color: theme.faint, letterSpacing: 1 }}>
                TO-DOS
              </AppText>
              <Todos todos={plan.todos} />
            </View>
          ) : null}
          {plan.phases?.map((phase, index) => (
            <View key={`${phase.name}:${index}`} style={{ gap: 8 }}>
              <AppText variant="text-14-medium" style={{ color: theme.fg }}>
                {phase.name}
              </AppText>
              <Todos todos={phase.todos} />
            </View>
          ))}
        </View>
      </ScrollView>
    </Sheet>
  )
}
