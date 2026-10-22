import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  usePermissionStateOptional,
  usePlanStateOptional,
  useQuestionFlow,
  useQuestionStateOptional,
} from '@openmanager/app-core/logic'

import { permissionChoices, type ComposerPrompt } from './model'

const reasonOf = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback

/**
 * What the composer becomes while the session waits on the reader: the
 * pending permission, question or plan of the thread on screen, from the
 * shared interaction providers (the environment's pending interactions,
 * nothing kept here). Each is answered through `interaction.respond`, as on
 * web, and stays until the environment says it is resolved, expired or
 * gone: an answer from web, or this one landing, is what takes it away.
 * Nothing here times out.
 *
 * `build` runs a plan's Build: accept it, then start the build in
 * `buildModeId` (web's `submitBuildPlan`, through the shared plan state).
 */
export function useComposerPrompt({
  build,
  buildModeLabel,
}: {
  build: ((requestId: string) => Promise<void>) | null
  buildModeLabel: string | null
}): ComposerPrompt | null {
  const permissionState = usePermissionStateOptional()
  const questionState = useQuestionStateOptional()
  const planState = usePlanStateOptional()
  const permission = permissionState?.pendingPermission ?? null
  const question = questionState?.pendingQuestion ?? null
  const plan = planState?.pendingPlan ?? null
  const flow = useQuestionFlow(question, questionState?.resolveQuestion)

  // The answer this phone sent and is waiting on, by request; and what went wrong.
  const [answering, setAnswering] = useState<string | null>(null)
  const [failure, setFailure] = useState<{ requestId: string; text: string } | null>(null)
  const permissionId = permission?.requestId ?? null
  useEffect(() => {
    // A new request (or none): the last one's answer and failure are done with.
    setAnswering((current) => (current === permissionId ? current : null))
  }, [permissionId])

  const resolvePermission = permissionState?.resolvePermission
  const answer = useCallback(
    (optionId: string) => {
      if (!permissionId || !resolvePermission) return
      setAnswering(permissionId)
      setFailure(null)
      resolvePermission({ optionId }).then(
        // Answered: the request stays on screen until the environment says it is resolved.
        () => undefined,
        (error: unknown) => {
          setAnswering((current) => (current === permissionId ? null : current))
          setFailure({ requestId: permissionId, text: reasonOf(error, 'The answer did not land') })
        },
      )
    },
    [permissionId, resolvePermission],
  )

  // Build runs the shared ordered job: the plan state calls the handler.
  const setBuildHandler = planState?.setBuildHandler
  const planId = plan?.requestId ?? null
  useEffect(() => {
    if (!setBuildHandler) return
    setBuildHandler(build && planId ? () => build(planId) : null)
    return () => setBuildHandler(null)
  }, [build, planId, setBuildHandler])
  const buildPendingPlan = planState?.buildPendingPlan
  const runBuild = useCallback(() => {
    if (!buildPendingPlan || !planId) return
    setFailure(null)
    buildPendingPlan().catch((error: unknown) =>
      setFailure({ requestId: planId, text: reasonOf(error, 'The plan was not built') }),
    )
  }, [buildPendingPlan, planId])

  const failureFor = (requestId: string) => (failure?.requestId === requestId ? failure.text : null)

  return useMemo((): ComposerPrompt | null => {
    if (permission) {
      return {
        kind: 'permission',
        requestId: permission.requestId,
        title: permission.description || permission.toolName,
        detail: permission.permission ?? null,
        choices: permissionChoices(permission.options),
        answer,
        answering: answering === permission.requestId,
        error: failureFor(permission.requestId),
      }
    }
    if (question && flow) {
      return {
        kind: 'question',
        requestId: question.requestId,
        title: question.title ?? null,
        flow,
        error: failureFor(question.requestId),
      }
    }
    if (plan) {
      return {
        kind: 'plan',
        requestId: plan.requestId,
        plan,
        build: runBuild,
        building: planState?.isBuilding ?? false,
        buildModeLabel,
        error: failureFor(plan.requestId),
      }
    }
    return null
    // `failureFor` reads `failure`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    answer,
    answering,
    buildModeLabel,
    failure,
    flow,
    permission,
    plan,
    planState?.isBuilding,
    question,
    runBuild,
  ])
}
