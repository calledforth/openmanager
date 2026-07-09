import { useLocalSearchParams, useRouter } from 'expo-router'
import { ChevronLeft, MoreVertical } from 'lucide-react-native'
import { useCallback, useMemo, useRef, useState } from 'react'
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  TouchableOpacity,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { Composer } from '../../components/chat/Composer'
import { PermissionBanner } from '../../components/chat/PermissionBanner'
import { ResolvedMessage } from '../../components/chat/ResolvedMessage'
import { StatusDot } from '../../components/StatusDot'
import { AppText } from '../../components/ui/AppText'
import { confirmDestructive, showAlert, showDestructiveActionSheet } from '../../lib/dialogs'
import { useSessionActions } from '../../data/actions'
import { useMobileClientId } from '../../data/client-id'
import { usePendingPermission } from '../../data/usePendingPermission'
import { useSession } from '../../data/useSession'
import { useSessionMessages, type SessionMessage } from '../../data/useSessionMessages'
import { useTokens } from '../../theme/useTokens'

// Phase 4 chat screen: header (back, 1-line title, status, overflow menu),
// message timeline with desktop-parity auto-stick scrolling, streaming via
// ResolvedMessage, permission banner, and the reachability-gated composer.

const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 96
const ACTIVE_STATUSES = new Set(['running', 'busy', 'waiting'])

export default function SessionScreen() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const tokens = useTokens()
  const { externalId, workspacePath } = useLocalSearchParams<{
    externalId: string
    workspacePath?: string
  }>()

  const clientId = useMobileClientId()
  const { session, isReachable } = useSession(externalId)
  const { messages, isLoading, addOptimisticMessage, removeOptimisticMessage } =
    useSessionMessages(externalId)
  const pendingPermission = usePendingPermission(externalId)
  const { sendMessage, abortSession, resolvePermission, deleteSession } =
    useSessionActions(clientId)

  // Actions additionally require the workspace path (only carried via the
  // route param — the session doc doesn't store it) and a client identity.
  const canAct = isReachable && !!workspacePath && !!clientId
  const isSessionActive = ACTIVE_STATUSES.has(session?.status ?? '')
  const title = session?.title?.trim() ? session.title : 'Untitled session'

  const chatMessages = useMemo(
    () => messages.filter((message) => message.role !== 'permission'),
    [messages],
  )

  // --- Auto-stick scrolling (port of desktop shouldAutoScroll semantics) ---
  const listRef = useRef<FlatList<SessionMessage>>(null)
  const shouldAutoScrollRef = useRef(true)
  const lastOffsetRef = useRef(0)

  const stickToBottom = useCallback(() => {
    if (!shouldAutoScrollRef.current) return
    listRef.current?.scrollToEnd({ animated: false })
  }, [])

  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent
    const distanceFromBottom = contentSize.height - layoutMeasurement.height - contentOffset.y
    const scrolledUp = contentOffset.y < lastOffsetRef.current - 1
    if (distanceFromBottom <= AUTO_SCROLL_BOTTOM_THRESHOLD_PX) {
      shouldAutoScrollRef.current = true
    } else if (scrolledUp) {
      shouldAutoScrollRef.current = false
    }
    lastOffsetRef.current = contentOffset.y
  }, [])

  // --- Permission banner with optimistic hide after submit ---
  const [resolvedRequestId, setResolvedRequestId] = useState<string | null>(null)
  const visiblePermission =
    pendingPermission && pendingPermission.requestId !== resolvedRequestId
      ? pendingPermission
      : null

  const handleResolvePermission = useCallback(
    (approved: boolean) => {
      if (!pendingPermission || !workspacePath || !externalId) return
      setResolvedRequestId(pendingPermission.requestId)
      resolvePermission({
        workspacePath,
        sessionExternalId: externalId,
        permissionId: pendingPermission.requestId,
        approved,
      }).catch(() => {
        setResolvedRequestId(null)
        showAlert('Could not submit decision', 'Please try again.')
      })
    },
    [pendingPermission, workspacePath, externalId, resolvePermission],
  )

  // --- Composer actions ---
  const handleSend = useCallback(
    (content: string) => {
      if (!workspacePath || !externalId) return
      const optimisticId = addOptimisticMessage(content)
      shouldAutoScrollRef.current = true
      sendMessage({ workspacePath, sessionExternalId: externalId, content }).catch(() => {
        if (optimisticId) removeOptimisticMessage(optimisticId)
        showAlert('Could not send message', 'Please try again.')
      })
    },
    [workspacePath, externalId, addOptimisticMessage, removeOptimisticMessage, sendMessage],
  )

  const handleAbort = useCallback(() => {
    if (!workspacePath || !externalId) return
    abortSession({ workspacePath, sessionExternalId: externalId }).catch(() => {
      showAlert('Could not stop session', 'Please try again.')
    })
  }, [workspacePath, externalId, abortSession])

  const handleDelete = useCallback(() => {
    if (!externalId || !workspacePath) return
    confirmDestructive({
      title: 'Delete this session?',
      message: 'This removes the session from the desktop app. This cannot be undone.',
      confirmLabel: 'Delete',
      onConfirm: () => {
        deleteSession({ workspacePath, sessionExternalId: externalId })
          .then(() => router.back())
          .catch(() => {
            showAlert('Could not delete session', 'Please try again in a moment.')
          })
      },
    })
  }, [externalId, workspacePath, deleteSession, router])

  const handleOverflowMenu = useCallback(() => {
    // Native: two-step action sheet (menu → confirm). Web: straight to the
    // destructive confirm via handleDelete.
    showDestructiveActionSheet({
      title,
      actionLabel: 'Delete session',
      onSelect: handleDelete,
    })
  }, [title, handleDelete])

  const renderItem = useCallback(
    ({ item }: { item: SessionMessage }) => (
      <ResolvedMessage message={item} onStreamUpdate={stickToBottom} />
    ),
    [stickToBottom],
  )

  return (
    <View className="flex-1 bg-background" style={{ paddingTop: insets.top }}>
      {/* Header */}
      <View className="flex-row items-center gap-2 border-b border-borderMuted px-3 pb-2 pt-2">
        <TouchableOpacity
          activeOpacity={0.7}
          hitSlop={12}
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <ChevronLeft size={20} color={tokens.textMuted} strokeWidth={2} />
        </TouchableOpacity>
        <StatusDot active={isSessionActive} />
        <AppText variant="text-13-medium" numberOfLines={1} className="flex-1 text-textStrong">
          {title}
        </AppText>
        <TouchableOpacity
          activeOpacity={0.7}
          hitSlop={12}
          onPress={handleOverflowMenu}
          accessibilityRole="button"
          accessibilityLabel="Session options"
        >
          <MoreVertical size={18} color={tokens.textMuted} strokeWidth={2} />
        </TouchableOpacity>
      </View>

      <KeyboardAvoidingView
        className="flex-1"
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={insets.top}
      >
        {/* Timeline */}
        {chatMessages.length === 0 ? (
          <View className="flex-1 items-center justify-center px-8">
            <AppText variant="text-13-regular" className="text-center text-textMuted">
              {isLoading ? 'Loading messages…' : 'Send a message to start'}
            </AppText>
          </View>
        ) : (
          <FlatList
            ref={listRef}
            data={chatMessages}
            keyExtractor={(message) => message.externalId}
            renderItem={renderItem}
            onScroll={handleScroll}
            scrollEventThrottle={32}
            onContentSizeChange={stickToBottom}
            contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 16 }}
            keyboardShouldPersistTaps="handled"
          />
        )}

        {/* Permission banner pinned above the composer */}
        {visiblePermission && canAct ? (
          <PermissionBanner permission={visiblePermission} onResolve={handleResolvePermission} />
        ) : null}

        {/* Composer */}
        <View style={{ paddingBottom: insets.bottom }} className="bg-background">
          <Composer
            isReachable={canAct}
            isSessionActive={isSessionActive}
            onSend={handleSend}
            onAbort={handleAbort}
          />
        </View>
      </KeyboardAvoidingView>
    </View>
  )
}
