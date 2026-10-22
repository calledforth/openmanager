/**
 * The composer's glyphs, drawn from the mockup's own paths
 * (docs/ui-prototypes/mobile/02-composer-and-pickers.html) so the picks read
 * the same on the phone as in the frames.
 */
import Svg, { Path, Rect } from 'react-native-svg'

type GlyphProps = { size?: number; color: string }

/** A mode pick: the hexagon. */
export function ModeGlyph({ size = 13, color }: GlyphProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        d="M4 12l4-7h8l4 7-4 7H8z"
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinejoin="round"
      />
    </Svg>
  )
}

/** Plan mode: three rules. */
export function PlanGlyph({ size = 13, color }: GlyphProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d="M5 6h14M5 12h10M5 18h7" stroke={color} strokeWidth={2.2} strokeLinecap="round" />
    </Svg>
  )
}

/** A mode that asks for nothing: the bolt. */
export function BypassGlyph({ size = 13, color }: GlyphProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d="M13 3L5 14h6l-1 7 9-12h-6z" fill={color} />
    </Svg>
  )
}

/** Which glyph a mode takes: plan, the ones that run without asking, the rest. */
export function ModeIcon({ modeId, size, color }: GlyphProps & { modeId: string }) {
  if (modeId === 'plan') return <PlanGlyph size={size} color={color} />
  if (modeId === 'bypassPermissions' || modeId === 'dontAsk' || modeId === 'yolo')
    return <BypassGlyph size={size} color={color} />
  return <ModeGlyph size={size} color={color} />
}

/**
 * Effort: three bars, as many lit as the level's place in the provider's
 * list (the mockup's glyph lights two of three).
 */
export function EffortGlyph({
  size = 13,
  color,
  level = 2,
}: GlyphProps & {
  /** How many bars are lit, 1–3. */
  level?: number
}) {
  const lit = (bar: number) => (bar <= level ? 1 : 0.35)
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Rect x={4} y={13} width={3.5} height={7} rx={1} fill={color} opacity={lit(1)} />
      <Rect x={10.25} y={9} width={3.5} height={11} rx={1} fill={color} opacity={lit(2)} />
      <Rect x={16.5} y={4} width={3.5} height={16} rx={1} fill={color} opacity={lit(3)} />
    </Svg>
  )
}

/** The effort glyph's lit bars for a level at `index` of `count`. */
export function effortLevelOf(index: number, count: number): number {
  if (count <= 1 || index < 0) return 2
  return Math.max(1, Math.min(3, Math.round(((index + 1) / count) * 3)))
}

export function AttachGlyph({ size = 20, color }: GlyphProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        d="M8 12.5l7.5-7.5a3.5 3.5 0 0 1 5 5L10 20.5a5.5 5.5 0 0 1-7.8-7.8L10 5"
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
      />
    </Svg>
  )
}

export function StopGlyph({ size = 14, color }: GlyphProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Rect x={6} y={6} width={12} height={12} rx={2.5} fill={color} />
    </Svg>
  )
}

export function SendGlyph({ size = 14, color }: GlyphProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        d="M12 19V6M6 12l6-6 6 6"
        fill="none"
        stroke={color}
        strokeWidth={2.6}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  )
}

export function SlashGlyph({ size = 13, color }: GlyphProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d="M15 4L9 20" stroke={color} strokeWidth={2.2} strokeLinecap="round" />
    </Svg>
  )
}

export function ImageGlyph({ size = 13, color }: GlyphProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Rect
        x={4}
        y={5}
        width={16}
        height={14}
        rx={2.5}
        fill="none"
        stroke={color}
        strokeWidth={2}
      />
      <Path
        d="M4 16l4.5-4.5 4 4 3-3L20 16"
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinejoin="round"
      />
    </Svg>
  )
}

/** The model pick's caret: a chevron turned down. */
export function CaretGlyph({ size = 9, color }: GlyphProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        d="M6 9l6 6 6-6"
        fill="none"
        stroke={color}
        strokeWidth={2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  )
}
