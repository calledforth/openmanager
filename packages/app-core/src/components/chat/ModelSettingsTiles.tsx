import { useState, type KeyboardEvent, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import {
  CaretDownIcon,
  CheckIcon,
  FadersHorizontalIcon,
  LightningIcon,
} from '@phosphor-icons/react'
import type { SessionConfigOption } from '@agentpack/contract'
import { cn } from '../../lib/utils'
import { Tooltip } from '../ui/Tooltip'
import { usePortaledMenu } from '../ui/usePortaledMenu'
import { composerChip, composerPopover } from './chatComposerStyles'
import {
  configurableSessionOptions,
  isBooleanSelect,
  sessionConfigSummary,
  type SessionConfigValue,
} from './modelConfig'

export type EffortChoice = { id: string; name: string; description?: string }

/** The reasoning-depth control, whatever the provider calls it. */
export type EffortControl = {
  /** Cheapest first — the order the bars rise in. */
  choices: EffortChoice[]
  /** Blank, or an id outside `choices`, means the CLI picks its own depth. */
  current: string
  onChange: (id: string) => void
}

/** A select with more options than this opens a list in place instead of
 *  cycling: clicking through eight output styles is a chore. */
const CYCLE_LIMIT = 4

/** The one colour here: the ⚡ of fast mode. Everything else is the text
 *  colour at some strength, so the tiles sit quietly in either theme. */
const FAST_COLOR = '#4d7cff'
/** The same electric blue, pulled toward the text colour so "On" reads in
 *  either theme. */
const FAST_TEXT = `color-mix(in srgb, ${FAST_COLOR} 78%, var(--basis-text-strong))`

const tint = (color: string, percent: number) =>
  `color-mix(in srgb, ${color} ${percent}%, transparent)`

const ink = (percent: number) => `color-mix(in srgb, var(--basis-text) ${percent}%, transparent)`

/** A lit effort bar: one ink, a step stronger at each level. */
function levelInk(index: number, count: number): string {
  return ink(Math.round(45 + (45 * index) / Math.max(1, count - 1)))
}

function isFastOption(option: SessionConfigOption): boolean {
  const toggle = option.type === 'boolean' || isBooleanSelect(option)
  return toggle && (/fast/i.test(option.id) || /fast/i.test(option.category ?? ''))
}

function isOn(option: SessionConfigOption): boolean {
  return option.type === 'boolean'
    ? option.currentValue
    : option.currentValue.toLowerCase() === 'true'
}

/** Fast mode shows in the pill as a ⚡, not as words. */
export function fastModeOn(options: readonly SessionConfigOption[] | undefined): boolean {
  return configurableSessionOptions(options).some((option) => isFastOption(option) && isOn(option))
}

/** Claude's levels arrive as bare ids ("xhigh"); providers that name their
 *  levels ("Extra-high") keep their own names. */
export function effortDisplayName(name: string): string {
  if (name === 'xhigh') return 'X-High'
  return /^[a-z]+$/.test(name) ? name.charAt(0).toUpperCase() + name.slice(1) : name
}

function effortIndex(effort: EffortControl): number {
  return effort.choices.findIndex((choice) => choice.id === effort.current)
}

export function hasModelSettings(
  options: readonly SessionConfigOption[] | undefined,
  effort: EffortControl | undefined,
): boolean {
  return (effort?.choices.length ?? 0) > 0 || configurableSessionOptions(options).length > 0
}

/** What a pill says about the settings: the effort level, then only values
 *  worth reading — an output style left on "default" says nothing, and fast
 *  mode is an icon (`fastModeOn`), not a word. */
export function modelSettingsSummary(
  options: readonly SessionConfigOption[] | undefined,
  effort: EffortControl | undefined,
): string[] {
  const parts: string[] = []
  if (effort && effort.choices.length > 0) {
    const current = effort.choices[effortIndex(effort)]
    parts.push(current ? effortDisplayName(current.name) : 'Auto')
  }
  const worded = configurableSessionOptions(options).filter((option) => !isFastOption(option))
  for (const part of sessionConfigSummary(worded)) {
    if (part.toLowerCase() !== 'default') parts.push(part)
  }
  return parts
}

/** Rising bars, lit in the text colour up to the current level. Draws
 *  nothing lit for "Auto". */
export function EffortMeter({
  level,
  count,
  className,
}: {
  level: number
  count: number
  className?: string
}) {
  const width = count * 4 - 1.5
  return (
    <svg
      width={width}
      height={11}
      viewBox={`0 0 ${width} 12`}
      aria-hidden
      className={cn('shrink-0', className)}
    >
      {Array.from({ length: count }, (_, i) => {
        const height = 4 + (8 * i) / Math.max(1, count - 1)
        const lit = i <= level
        return (
          <rect
            key={i}
            x={i * 4}
            y={12 - height}
            width={2.5}
            height={height}
            rx={1}
            fill="currentColor"
            opacity={lit ? 0.9 : 0.25}
          />
        )
      })}
    </svg>
  )
}

// Plain-size utilities only: `cn` (tailwind-merge) reads the `text-11-*`
// typography classes as colours and drops them next to a text colour.
const tileBase =
  'relative flex min-w-0 flex-col items-start rounded-[8px] px-2.5 py-2 text-left transition-colors duration-100'
const tileLabel = 'text-[10.5px] leading-4 text-[var(--basis-text-faint)]'
const tileValue =
  'max-w-full truncate text-[12px] font-medium leading-4 text-[var(--basis-text-strong)]'
const tileSub = 'max-w-full truncate text-[10.5px] leading-4 text-[var(--basis-text-muted)]'
/** Chosen is a fill; not chosen is a dotted outline you could fill. */
const picked =
  'border border-transparent bg-[color-mix(in_srgb,var(--basis-text)_16%,transparent)] text-[var(--basis-text-strong)]'
const unpicked =
  'border border-dotted border-[color-mix(in_srgb,var(--basis-text)_26%,transparent)] text-[var(--basis-text-muted)] hover:border-[color-mix(in_srgb,var(--basis-text)_45%,transparent)] hover:text-[var(--basis-text)]'

/** Tiles act on click without taking focus: a pointer press should not
 *  leave a focus ring on the tile it just changed. */
const keepFocus = (event: MouseEvent) => event.preventDefault()

type TileKind = 'segments' | 'cycle' | 'toggle' | 'fixed' | 'list'

/** A two-way choice (context window) shows both sides to pick from; a few
 *  more cycle on click; past that, a list opens in place. */
function tileKind(option: SessionConfigOption): TileKind {
  if (option.type === 'boolean' || isBooleanSelect(option)) return 'toggle'
  const count = option.options.length
  if (count <= 1) return 'fixed'
  if (count === 2) return 'segments'
  return count <= CYCLE_LIMIT ? 'cycle' : 'list'
}

/** Whether a tile needs the whole row. Two short choices fit in half. */
function wantsFullRow(option: SessionConfigOption): boolean {
  if (option.type !== 'select' || tileKind(option) !== 'segments') return false
  return option.options.reduce((sum, entry) => sum + entry.name.length, 0) > 10
}

/** Row spans for the grid: a half tile left alone on its row takes the row. */
function layoutSpans(options: SessionConfigOption[]): boolean[] {
  const spans = options.map(wantsFullRow)
  let pendingHalf: number | null = null
  spans.forEach((full, index) => {
    if (full) {
      if (pendingHalf !== null) spans[pendingHalf] = true
      pendingHalf = null
    } else if (pendingHalf === null) {
      pendingHalf = index
    } else {
      pendingHalf = null
    }
  })
  if (pendingHalf !== null) spans[pendingHalf] = true
  return spans
}

/**
 * A model's settings as a small control-centre grid. Effort is a wide tile of
 * rising bars and a two-way choice shows both sides — for those, what is
 * chosen takes a stronger fill than what is not. A few-way choice cycles on
 * click (⇧-click steps back), a toggle fills when on, and a long choice opens
 * a list in place.
 */
export function ModelSettingsTiles({
  options,
  effort,
  onChange,
  disabled,
  className,
}: {
  options: readonly SessionConfigOption[] | undefined
  effort?: EffortControl | undefined
  onChange: (configId: string, value: SessionConfigValue) => void
  disabled?: boolean | undefined
  className?: string | undefined
}) {
  const [listOpen, setListOpen] = useState<string | null>(null)
  const configurable = configurableSessionOptions(options)
  const showEffort = !!effort && effort.choices.length > 0
  if (!showEffort && configurable.length === 0) return null
  const spans = layoutSpans(configurable)

  return (
    <div className={cn(disabled && 'pointer-events-none opacity-40', className)}>
      <div className="grid grid-cols-2 gap-1.5">
        {showEffort && effort && <EffortTile effort={effort} />}
        {configurable.map((option, index) => (
          <SettingTile
            key={option.id}
            option={option}
            span={spans[index] ?? false}
            listOpen={listOpen === option.id}
            onToggleList={() => setListOpen((open) => (open === option.id ? null : option.id))}
            onChange={(value) => {
              setListOpen(null)
              onChange(option.id, value)
            }}
          />
        ))}
      </div>
    </div>
  )
}

function EffortTile({ effort }: { effort: EffortControl }) {
  const [hovered, setHovered] = useState<number | null>(null)
  const current = effortIndex(effort)
  const count = effort.choices.length
  // One caption per level, then the one for "Auto" (no level chosen).
  const captions = [
    ...effort.choices.map((choice) => choice.description ?? ''),
    'The model picks its own depth',
  ]
  const shownIndex = hovered ?? current
  const shownCaption = shownIndex >= 0 ? shownIndex : count

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowUp'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowDown'
          ? -1
          : 0
    if (step === 0) return
    event.preventDefault()
    const next = Math.min(count - 1, Math.max(0, current + step))
    const target = effort.choices[next]
    if (!target || next === current) return
    effort.onChange(target.id)
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus()
  }

  return (
    <div
      role="radiogroup"
      aria-label="Reasoning effort"
      onKeyDown={onKeyDown}
      className="col-span-2 rounded-[8px] bg-hover px-2.5 pb-2 pt-2"
    >
      <span className={tileLabel}>Reasoning</span>
      <div className="mt-1.5 flex h-8 items-end gap-1" onMouseLeave={() => setHovered(null)}>
        {effort.choices.map((level, i) => {
          const filled = i <= current
          // Pointing at a level firms up the outlines it would fill.
          const previewed = hovered !== null && i <= hovered
          return (
            <button
              key={level.id}
              type="button"
              role="radio"
              aria-checked={i === current}
              aria-label={effortDisplayName(level.name)}
              tabIndex={i === Math.max(0, current) ? 0 : -1}
              onMouseDown={keepFocus}
              onMouseEnter={() => setHovered(i)}
              onClick={() => effort.onChange(level.id)}
              style={{
                height: `${34 + (66 * i) / Math.max(1, count - 1)}%`,
                ...(filled
                  ? { backgroundColor: levelInk(i, count) }
                  : { borderColor: ink(previewed ? 55 : 28) }),
              }}
              className={cn(
                'flex-1 rounded-[4px] border transition-colors duration-100',
                // Not reached: a dotted outline, no fill.
                filled ? 'border-transparent' : 'border-dotted',
              )}
            />
          )
        })}
      </div>
      <div className="mt-1 flex gap-1" aria-hidden>
        {effort.choices.map((level, i) => (
          <span
            key={level.id}
            className={cn(
              'flex-1 truncate text-center text-[10px] leading-4',
              i === current
                ? 'font-medium text-[var(--basis-text-strong)]'
                : 'text-[var(--basis-text-faint)]',
            )}
          >
            {effortDisplayName(level.name)}
          </span>
        ))}
      </div>
      {(current < 0 || effort.choices.some((choice) => choice.description)) && (
        // Every caption shares one cell and only the shown one is visible, so
        // the tile is as tall as its longest (wrapped) caption and never jumps.
        <div className="mt-1.5 grid text-[10.5px] leading-4 text-[var(--basis-text-muted)]">
          {captions.map((caption, i) => (
            <span
              key={i}
              aria-hidden={i !== shownCaption}
              className={cn('col-start-1 row-start-1', i !== shownCaption && 'invisible')}
            >
              {caption}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function SettingTile({
  option,
  span,
  listOpen,
  onToggleList,
  onChange,
}: {
  option: SessionConfigOption
  span: boolean
  listOpen: boolean
  onToggleList: () => void
  onChange: (value: SessionConfigValue) => void
}) {
  const kind = tileKind(option)

  if (kind === 'toggle') {
    const checked = isOn(option)
    const toggle = () => {
      if (option.type === 'boolean') return onChange(!option.currentValue)
      const next = option.options.find(
        (entry) => entry.value.toLowerCase() === String(!checked),
      )?.value
      if (next !== undefined) onChange(next)
    }
    const fast = isFastOption(option)
    const lit = fast && checked
    const mark = fast ? (
      <LightningIcon
        size={13}
        weight={checked ? 'fill' : 'regular'}
        style={checked ? { color: FAST_COLOR } : undefined}
        className={cn('shrink-0', !checked && 'text-[var(--basis-text-faint)]')}
      />
    ) : (
      <span
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: checked ? ink(90) : ink(22) }}
      />
    )
    const value = (
      <span
        className={cn(tileValue, !checked && 'text-[var(--basis-text-muted)]')}
        style={lit ? { color: FAST_TEXT } : undefined}
      >
        {checked ? 'On' : 'Off'}
      </span>
    )
    return (
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={option.name}
        title={option.description}
        onMouseDown={keepFocus}
        onClick={toggle}
        // Fast mode, on, is the one tile with colour: a flat electric-blue wash.
        style={lit ? { backgroundColor: tint(FAST_COLOR, 16) } : undefined}
        className={cn(
          tileBase,
          lit
            ? 'hover:brightness-110'
            : checked
              ? 'bg-[color-mix(in_srgb,var(--basis-text)_14%,transparent)] hover:bg-[color-mix(in_srgb,var(--basis-text)_18%,transparent)]'
              : 'bg-hover hover:bg-active',
          // Alone on its row, a switch is one slim line, not a tall block.
          span ? 'col-span-2 h-8 flex-row items-center gap-2 py-0' : 'gap-0.5',
        )}
      >
        {span ? (
          <>
            <span className="min-w-0 flex-1 truncate text-[11.5px] leading-4 text-[var(--basis-text)]">
              {option.name}
            </span>
            {value}
            {mark}
          </>
        ) : (
          <>
            <span className={tileLabel}>{option.name}</span>
            {value}
            <span className="absolute right-2.5 top-2.5 flex h-3.5 items-center">{mark}</span>
          </>
        )}
      </button>
    )
  }

  if (option.type !== 'select') return null
  const selected = option.options.find((entry) => entry.value === option.currentValue)
  const valueName = selected?.name ?? option.currentValue

  // One choice only: a fact about the model, not a control.
  if (kind === 'fixed') {
    return (
      <div
        title={option.description}
        className={cn(tileBase, 'cursor-default gap-0.5 bg-hover opacity-70', span && 'col-span-2')}
      >
        <span className={tileLabel}>{option.name}</span>
        <span className={tileValue}>{valueName}</span>
        <span className={tileSub}>Fixed on this model</span>
      </div>
    )
  }

  if (kind === 'segments') {
    return (
      <div
        role="radiogroup"
        aria-label={option.name}
        title={option.description}
        className={cn(tileBase, 'cursor-default gap-1.5 bg-hover', span && 'col-span-2')}
      >
        <span className={tileLabel}>{option.name}</span>
        <div className="flex w-full gap-1">
          {option.options.map((entry) => {
            const on = entry.value === option.currentValue
            return (
              <button
                key={entry.value}
                type="button"
                role="radio"
                aria-checked={on}
                title={entry.description}
                onMouseDown={keepFocus}
                onClick={() => {
                  if (!on) onChange(entry.value)
                }}
                className={cn(
                  'flex h-7 min-w-0 flex-1 items-center justify-center rounded-[6px] px-2 transition-colors duration-100',
                  on ? picked : unpicked,
                )}
              >
                {/* Size and weight on a span: globals.css gives buttons an
                    unlayered `font: inherit` that outranks utilities. */}
                <span className={cn('truncate text-[11.5px]', on && 'font-medium')}>
                  {entry.name}
                </span>
              </button>
            )
          })}
        </div>
      </div>
    )
  }

  if (kind === 'cycle') {
    const count = option.options.length
    const index = option.options.findIndex((entry) => entry.value === option.currentValue)
    const cycle = (step: 1 | -1) => {
      const next = option.options[(index + step + count) % count]
      if (next) onChange(next.value)
    }
    return (
      <button
        type="button"
        title={option.description}
        aria-label={`${option.name}: ${valueName}`}
        onMouseDown={keepFocus}
        onClick={(event) => cycle(event.shiftKey ? -1 : 1)}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
          event.preventDefault()
          cycle(event.key === 'ArrowRight' ? 1 : -1)
        }}
        className={cn(tileBase, 'gap-0.5 bg-hover hover:bg-active', span && 'col-span-2')}
      >
        <span className={tileLabel}>{option.name}</span>
        <span className={tileValue}>{valueName}</span>
        {selected?.description && <span className={tileSub}>{selected.description}</span>}
        <span className="absolute right-2.5 top-3 flex gap-[3px]" aria-hidden>
          {option.options.map((entry, i) => (
            <span
              key={entry.value}
              className={cn(
                'h-1 w-1 rounded-full',
                i === index
                  ? 'bg-[var(--basis-text-strong)]'
                  : 'bg-[color-mix(in_srgb,var(--basis-text)_22%,transparent)]',
              )}
            />
          ))}
        </span>
      </button>
    )
  }

  return (
    <div
      className={cn(
        'flex min-w-0 flex-col rounded-[8px] transition-colors duration-100',
        listOpen ? 'col-span-2 bg-active' : cn('bg-hover hover:bg-active', span && 'col-span-2'),
      )}
    >
      <button
        type="button"
        aria-expanded={listOpen}
        title={option.description}
        onMouseDown={keepFocus}
        onClick={onToggleList}
        className={cn(tileBase, 'w-full gap-0.5')}
      >
        <span className={tileLabel}>{option.name}</span>
        <span className={tileValue}>{valueName}</span>
        <CaretDownIcon
          size={10}
          className={cn(
            'absolute right-2.5 top-2.5 text-[var(--basis-text-faint)] transition-transform',
            listOpen && 'rotate-180',
          )}
        />
      </button>
      {listOpen && (
        <div
          role="listbox"
          aria-label={option.name}
          className="flex max-h-40 flex-col gap-px overflow-y-auto px-1.5 pb-1.5"
        >
          {option.options.map((entry) => {
            const on = entry.value === option.currentValue
            return (
              <button
                key={entry.value}
                type="button"
                role="option"
                aria-selected={on}
                title={entry.description}
                onMouseDown={keepFocus}
                onClick={() => onChange(entry.value)}
                className={cn(
                  'flex h-7 shrink-0 items-center justify-between gap-2 rounded-[6px] px-2 text-left',
                  on
                    ? 'bg-hover text-[var(--basis-text-strong)]'
                    : 'text-[var(--basis-text-muted)] hover:bg-hover hover:text-[var(--basis-text)]',
                )}
              >
                <span className={cn('truncate text-[11.5px]', on && 'font-medium')}>
                  {entry.name}
                </span>
                {on && <CheckIcon size={12} />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

const POPOVER_WIDTH = 288

/**
 * The composer's model-settings pill: the effort meter plus a short summary,
 * opening the tiles. Kept apart from the model picker on purpose — the
 * picker is a search list, and settings squeezed beside it read as clutter.
 */
export function ModelSettingsControl({
  options,
  effort,
  onChange,
  disabled,
}: {
  options: readonly SessionConfigOption[] | undefined
  effort?: EffortControl | undefined
  onChange: (configId: string, value: SessionConfigValue) => void
  disabled?: boolean | undefined
}) {
  const show = hasModelSettings(options, effort)
  const { open, toggle, menuCoords, wrapRef, triggerRef, menuRef } = usePortaledMenu({
    placement: 'above',
    minWidth: POPOVER_WIDTH,
    align: 'start',
    deps: [show],
  })
  if (!show) return null

  const summary = modelSettingsSummary(options, effort)
  const fast = fastModeOn(options)
  const hasEffort = !!effort && effort.choices.length > 0

  return (
    <div ref={wrapRef} className="flex shrink-0">
      <Tooltip content="Model settings">
        <button
          ref={triggerRef}
          type="button"
          onClick={toggle}
          disabled={disabled}
          aria-label="Model settings"
          aria-haspopup="dialog"
          aria-expanded={open}
          className={cn(
            composerChip,
            'max-w-[220px] gap-1.5',
            open && 'bg-active text-[var(--basis-text-strong)]',
          )}
        >
          {hasEffort ? (
            <EffortMeter level={effortIndex(effort)} count={effort.choices.length} />
          ) : (
            <FadersHorizontalIcon size={12} className="shrink-0" />
          )}
          {/* A phone's row keeps the first setting (the effort); the menu has the rest. */}
          {summary.length > 0 && (
            <span className="truncate">
              {summary[0]}
              {summary.length > 1 && (
                <span className="max-sm:hidden"> · {summary.slice(1).join(' · ')}</span>
              )}
            </span>
          )}
          {fast && (
            <LightningIcon
              size={11}
              weight="fill"
              aria-label="Fast mode on"
              className="shrink-0"
              style={{ color: FAST_COLOR }}
            />
          )}
          <CaretDownIcon
            size={9}
            weight="light"
            className="shrink-0 text-[var(--basis-text-faint)]"
          />
        </button>
      </Tooltip>
      {open &&
        menuCoords &&
        createPortal(
          <div
            ref={menuRef}
            role="dialog"
            aria-label="Model settings"
            className={cn('fixed z-[9999] p-1.5', composerPopover)}
            style={{
              left: menuCoords.left,
              top: menuCoords.top,
              bottom: menuCoords.bottom,
              width: menuCoords.width,
            }}
          >
            <ModelSettingsTiles
              options={options}
              {...(effort ? { effort } : {})}
              onChange={onChange}
              disabled={disabled}
            />
          </div>,
          document.body,
        )}
    </div>
  )
}
