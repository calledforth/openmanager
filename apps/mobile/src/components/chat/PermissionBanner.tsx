import { useState } from 'react'
import { ScrollView, TouchableOpacity, View } from 'react-native'

import type { PendingPermission } from '../../data/usePendingPermission'
import { AppText } from '../ui/AppText'

// Pinned above the composer whenever the session has a pending permission.
// toolName (text-13-medium textStrong) + description (text-12-regular
// textMuted), with the tool input expandable as mono JSON. Deny is a bordered
// transparent button, Approve the monochrome action button. The banner hides
// optimistically once either is submitted; the parent clears the submitted
// marker when the pending row actually changes/disappears.

export function PermissionBanner({
  permission,
  onResolve,
}: {
  permission: PendingPermission
  onResolve: (approved: boolean) => void
}) {
  const [showInput, setShowInput] = useState(false)

  const inputText =
    permission.input !== undefined && permission.input !== null
      ? typeof permission.input === 'string'
        ? permission.input
        : JSON.stringify(permission.input, null, 2)
      : ''

  return (
    <View className="mx-3 mb-2 rounded border border-border bg-surfaceElevated px-3 py-2.5">
      <AppText variant="text-13-medium" className="text-textStrong">
        {permission.toolName}
      </AppText>
      {permission.description ? (
        <AppText variant="text-12-regular" className="mt-0.5 text-textMuted">
          {permission.description}
        </AppText>
      ) : null}

      {inputText ? (
        <View className="mt-1.5">
          <TouchableOpacity
            activeOpacity={0.7}
            onPress={() => setShowInput((prev) => !prev)}
            hitSlop={6}
          >
            <AppText variant="text-11-medium" className="text-textFaint">
              {showInput ? 'Hide details' : 'Show details'}
            </AppText>
          </TouchableOpacity>
          {showInput ? (
            <ScrollView
              style={{ maxHeight: 180 }}
              className="mt-1 rounded border border-borderMuted bg-surface"
              contentContainerStyle={{ padding: 8 }}
              nestedScrollEnabled
            >
              <AppText variant="mono" className="text-textMuted" selectable>
                {inputText}
              </AppText>
            </ScrollView>
          ) : null}
        </View>
      ) : null}

      <View className="mt-2.5 flex-row justify-end gap-2">
        <TouchableOpacity
          activeOpacity={0.7}
          onPress={() => onResolve(false)}
          className="rounded border border-border bg-transparent px-4 py-1.5"
          accessibilityRole="button"
          accessibilityLabel="Deny"
        >
          <AppText variant="text-12-medium" className="text-text">
            Deny
          </AppText>
        </TouchableOpacity>
        <TouchableOpacity
          activeOpacity={0.7}
          onPress={() => onResolve(true)}
          className="rounded bg-actionBg px-4 py-1.5"
          accessibilityRole="button"
          accessibilityLabel="Approve"
        >
          <AppText variant="text-12-medium" className="text-actionFg">
            Approve
          </AppText>
        </TouchableOpacity>
      </View>
    </View>
  )
}
