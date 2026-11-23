import { useCallback, useEffect } from 'react'
import { ActivityIndicator, View } from 'react-native'
import type { ProviderLimitWindow } from '@openmanager/protocol'
import {
  selectProviderCatalog,
  shallowEqualArray,
  type EnvironmentState,
  type ProviderCatalogEntry,
} from '@openmanager/environment-client'
import {
  useConnectionState,
  useEnvironmentClient,
  useEnvironmentState,
} from '@openmanager/app-core/logic'
import { useNow } from '@openmanager/app-core/lib/relative-time'
import {
  creditsText,
  formatPercent,
  formatResetsAt,
  formatUpdated,
  limitsStatusLine,
  usageLevel,
  type UsageLevel,
} from '@openmanager/app-core/lib/usage-limits-view'

import { AppText } from '../components/ui/AppText'
import type { PhoneTheme } from '../theme/tokens'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { SectionLabel } from '../ui/chrome'
import { ProviderMark } from '../ui/ProviderMark'
import { RoundAction } from './DevicesSection'
import { SettingsRow } from './SettingsRow'

/** The capability an environment advertises when it can read limits again. */
const REFRESH_CAPABILITY = 'provider.limits.refresh'
/** A reading younger than this stands when the page opens (web's Usage page asks the same). */
const OPEN_MAX_AGE_MS = 60_000

const selectLimitsEntries = (state: EnvironmentState) =>
  selectProviderCatalog(state).filter(
    (entry: ProviderCatalogEntry) => entry.limits?.supported === true,
  )

function levelColor(theme: PhoneTheme, level: UsageLevel): string {
  switch (level) {
    case 'critical':
      return theme.status.error
    case 'warning':
      return theme.status.needs
    case 'normal':
      return theme.fg
    case 'unknown':
      return theme.faint
  }
}

const LEVEL_WORD: Partial<Record<UsageLevel, string>> = {
  warning: 'Running low',
  critical: 'Almost out',
}

/** One window, as web's `UsageMeter`: its label and percent, a thin bar, when it resets. */
function UsageMeter({ window, now }: { window: ProviderLimitWindow; now: number }) {
  const theme = usePhoneTheme()
  const level = usageLevel(window)
  const limited = window.status === 'limited'
  const used = limited ? 100 : window.usedPercent
  const word = limited ? 'Limit reached' : LEVEL_WORD[level]
  const reset = formatResetsAt(window.resetsAt, now)
  const color = levelColor(theme, level)
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={window.label}
      accessibilityValue={
        used === null ? { text: 'Unknown' } : { min: 0, max: 100, now: Math.round(used) }
      }
      style={{ gap: 5 }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
        <AppText
          variant="text-13-regular"
          numberOfLines={1}
          style={{ color: theme.fg, flexShrink: 1 }}
        >
          {window.label}
        </AppText>
        {word ? (
          <AppText variant="text-11-medium" style={{ color }}>
            {word}
          </AppText>
        ) : null}
        <AppText
          variant="text-13-regular"
          style={{ color: theme.fg, marginLeft: 'auto', fontVariant: ['tabular-nums'] }}
        >
          {limited ? '100%' : formatPercent(window.usedPercent)}
        </AppText>
      </View>
      <View
        style={{ height: 4, borderRadius: 2, backgroundColor: theme.hover, overflow: 'hidden' }}
      >
        <View
          style={{
            width: `${Math.max(0, Math.min(100, used ?? 0))}%`,
            height: '100%',
            borderRadius: 2,
            backgroundColor: color,
            opacity: level === 'normal' ? 0.8 : 1,
          }}
        />
      </View>
      {reset ? (
        <AppText variant="text-12-regular" style={{ color: theme.faint }}>
          {reset}
        </AppText>
      ) : null}
    </View>
  )
}

/** A line under the meters: what extra usage or credits stand at. */
function ExtraLine({ label, value }: { label: string; value: string }) {
  const theme = usePhoneTheme()
  return (
    <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
      <AppText variant="text-13-regular" style={{ color: theme.muted }}>
        {label}
      </AppText>
      <AppText
        variant="text-13-regular"
        style={{ color: theme.muted, marginLeft: 'auto', fontVariant: ['tabular-nums'] }}
      >
        {value}
      </AppText>
    </View>
  )
}

/**
 * The plan limits of the connected environment's providers (Claude's and
 * Codex's), as web's Usage page shows them: per provider, its mark (never its
 * name), its plan, how fresh the reading is and a refresh, then one meter per
 * window, extra usage and Codex's credits. Opening the page asks for a
 * reading older than a minute, as web's page does; the numbers arrive as the
 * environment's own update.
 */
export function UsageSection() {
  const theme = usePhoneTheme()
  const client = useEnvironmentClient()
  const entries = useEnvironmentState(selectLimitsEntries, shallowEqualArray)
  const canRefresh = useConnectionState().capabilities.includes(REFRESH_CAPABILITY)
  const now = useNow(15_000)
  const refresh = useCallback(
    (providerId: string, maxAgeMs?: number) => {
      if (!canRefresh) return
      // The answer is a state the environment's event also brings; a failure
      // only leaves the old reading, which the row already says.
      void client.commands
        .refreshProviderLimits({ providerId, ...(maxAgeMs !== undefined ? { maxAgeMs } : {}) })
        .catch(() => undefined)
    },
    [canRefresh, client],
  )
  const ids = entries.map((entry) => entry.id).join('\n')
  useEffect(() => {
    if (!ids) return
    for (const providerId of ids.split('\n')) refresh(providerId, OPEN_MAX_AGE_MS)
  }, [ids, refresh])

  if (entries.length === 0) return null
  return (
    <>
      <SectionLabel>Usage limits</SectionLabel>
      {entries.map((entry) => {
        const limits = entry.limits
        const reading = limits.reading
        const status = limitsStatusLine(limits)
        const updated =
          limits.refreshing && reading ? 'Refreshing…' : formatUpdated(reading?.at, now)
        const credits = creditsText(reading?.credits)
        const extra = reading?.extraUsage
        const plan = reading?.plan
        return (
          <View key={entry.id}>
            <SettingsRow
              icon={<ProviderMark providerId={entry.id} size={17} />}
              title={plan ? `${plan} plan` : 'Plan limits'}
              sub={status ?? updated ?? undefined}
              accessibilityLabel={`${entry.displayName} usage${plan ? `, ${plan} plan` : ''}`}
              trailing={
                canRefresh ? (
                  limits.refreshing ? (
                    <View
                      style={{
                        width: 32,
                        height: 32,
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <ActivityIndicator size="small" color={theme.muted} />
                    </View>
                  ) : (
                    <RoundAction
                      label={`Refresh ${entry.displayName} usage`}
                      icon="retry"
                      onPress={() => refresh(entry.id)}
                    />
                  )
                ) : undefined
              }
            />
            {reading && (reading.windows.length > 0 || extra || credits) ? (
              <View style={{ paddingLeft: 56, paddingRight: 12, paddingBottom: 10, gap: 14 }}>
                {reading.windows.map((window) => (
                  <UsageMeter key={window.id} window={window} now={now} />
                ))}
                {extra ? (
                  <ExtraLine
                    label="Extra usage"
                    value={
                      extra.enabled
                        ? extra.usedPercent !== null
                          ? `${formatPercent(extra.usedPercent)} of monthly limit`
                          : 'On'
                        : 'Off'
                    }
                  />
                ) : null}
                {credits ? <ExtraLine label="Credits" value={credits} /> : null}
              </View>
            ) : null}
          </View>
        )
      })}
    </>
  )
}
