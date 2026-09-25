"use client";

import { createContext, useContext, useMemo, type ComponentType, type ReactNode } from "react";

import {
  ArrowCounterClockwiseIcon,
  ArrowDownIcon,
  ArrowElbowDownLeftIcon,
  ArrowElbowDownRightIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  ArrowsOutSimpleIcon,
  BellIcon,
  BooksIcon,
  BrainIcon,
  CalendarBlankIcon,
  CaretDownIcon,
  CaretRightIcon,
  CaretUpDownIcon,
  ChatCircleIcon,
  CheckIcon,
  CircleIcon,
  CircleNotchIcon,
  ClockIcon,
  CopyIcon,
  DotIcon,
  DotsThreeIcon,
  DotsThreeVerticalIcon,
  EnvelopeSimpleIcon,
  EyedropperIcon,
  FolderSimpleIcon,
  GearSixIcon,
  GlobeIcon,
  HeartIcon,
  HouseIcon,
  ImageIcon,
  LightbulbIcon,
  LinkIcon,
  ListIcon,
  LockIcon,
  MagnifyingGlassIcon,
  MonitorIcon,
  MoonIcon,
  PaintBrushIcon,
  PaletteIcon,
  PauseIcon,
  PencilSimpleIcon,
  PlayIcon,
  PlusIcon,
  RectangleIcon,
  RocketIcon,
  ShieldIcon,
  SidebarSimpleIcon,
  SkipForwardIcon,
  SlidersHorizontalIcon,
  StarIcon,
  SunIcon,
  TrayIcon,
  UserIcon,
  UsersIcon,
  XIcon,
  type Icon as PhosphorIcon,
  type IconWeight,
} from "@phosphor-icons/react";

export interface IconComponentProps {
  size?: number;
  strokeWidth?: number;
  className?: string;
}

export type IconComponent = ComponentType<IconComponentProps>;

/**
 * Phosphor draws weights, not strokes. On a 24px grid a 1.5 stroke matches
 * Phosphor's regular weight, so the components' 1.5 → 2 emphasis becomes
 * regular → bold.
 */
function weightFor(strokeWidth: number | undefined): IconWeight {
  if (strokeWidth === undefined) return "regular";
  if (strokeWidth <= 1.25) return "light";
  if (strokeWidth <= 1.75) return "regular";
  return "bold";
}

/**
 * Adapts a Phosphor icon to the `IconComponentProps` contract, mapping
 * `strokeWidth` to a weight. `extraClassName` is merged ahead of the caller's
 * (used to mirror a glyph Phosphor only draws facing one way).
 */
export function phosphorIcon(Glyph: PhosphorIcon, extraClassName?: string): IconComponent {
  function FluidPhosphorIcon({ size, strokeWidth, className }: IconComponentProps) {
    return (
      <Glyph
        size={size ?? 24}
        weight={weightFor(strokeWidth)}
        className={extraClassName ? `${extraClassName} ${className ?? ""}`.trim() : className}
        aria-hidden
      />
    );
  }
  FluidPhosphorIcon.displayName = `Phosphor(${Glyph.displayName ?? "Icon"})`;
  return FluidPhosphorIcon;
}

export type IconName =
  | "chevron-right" | "chevron-down" | "x" | "copy" | "menu" | "dot"
  | "monitor" | "sun" | "moon" | "rectangle-horizontal" | "circle"
  | "square-library" | "clock" | "star" | "settings"
  | "plus" | "arrow-left" | "arrow-right" | "arrow-up" | "arrow-down"
  | "search" | "loader"
  | "users" | "lock" | "mail" | "bell" | "shield" | "palette"
  | "lightbulb" | "rocket" | "heart" | "paintbrush" | "brain"
  | "globe" | "user"
  | "image" | "link" | "check" | "rotate-ccw"
  | "play" | "pause" | "pipette"
  | "home" | "message-circle" | "inbox"
  | "pencil" | "scaling" | "skip-forward" | "corner-down-right" | "corner-down-left"
  | "panel-left" | "panel-right" | "chevrons-up-down" | "more-horizontal" | "more-vertical" | "calendar" | "folder"
  | "sliders-horizontal";

export const defaultIcons: Record<IconName, IconComponent> = {
  "chevron-right": phosphorIcon(CaretRightIcon),
  "chevron-down": phosphorIcon(CaretDownIcon),
  "pipette": phosphorIcon(EyedropperIcon),
  "x": phosphorIcon(XIcon),
  "copy": phosphorIcon(CopyIcon),
  "menu": phosphorIcon(ListIcon),
  "dot": phosphorIcon(DotIcon),
  "monitor": phosphorIcon(MonitorIcon),
  "sun": phosphorIcon(SunIcon),
  "moon": phosphorIcon(MoonIcon),
  "rectangle-horizontal": phosphorIcon(RectangleIcon),
  "circle": phosphorIcon(CircleIcon),
  "square-library": phosphorIcon(BooksIcon),
  "clock": phosphorIcon(ClockIcon),
  "star": phosphorIcon(StarIcon),
  "settings": phosphorIcon(GearSixIcon),
  "plus": phosphorIcon(PlusIcon),
  "arrow-left": phosphorIcon(ArrowLeftIcon),
  "arrow-right": phosphorIcon(ArrowRightIcon),
  "arrow-up": phosphorIcon(ArrowUpIcon),
  "arrow-down": phosphorIcon(ArrowDownIcon),
  "search": phosphorIcon(MagnifyingGlassIcon),
  "loader": phosphorIcon(CircleNotchIcon),
  "users": phosphorIcon(UsersIcon),
  "lock": phosphorIcon(LockIcon),
  "mail": phosphorIcon(EnvelopeSimpleIcon),
  "bell": phosphorIcon(BellIcon),
  "shield": phosphorIcon(ShieldIcon),
  "palette": phosphorIcon(PaletteIcon),
  "lightbulb": phosphorIcon(LightbulbIcon),
  "rocket": phosphorIcon(RocketIcon),
  "heart": phosphorIcon(HeartIcon),
  "paintbrush": phosphorIcon(PaintBrushIcon),
  "brain": phosphorIcon(BrainIcon),
  "globe": phosphorIcon(GlobeIcon),
  "user": phosphorIcon(UserIcon),
  "image": phosphorIcon(ImageIcon),
  "link": phosphorIcon(LinkIcon),
  "check": phosphorIcon(CheckIcon),
  "rotate-ccw": phosphorIcon(ArrowCounterClockwiseIcon),
  "play": phosphorIcon(PlayIcon),
  "pause": phosphorIcon(PauseIcon),
  "home": phosphorIcon(HouseIcon),
  "message-circle": phosphorIcon(ChatCircleIcon),
  "inbox": phosphorIcon(TrayIcon),
  "pencil": phosphorIcon(PencilSimpleIcon),
  "scaling": phosphorIcon(ArrowsOutSimpleIcon),
  "skip-forward": phosphorIcon(SkipForwardIcon),
  "corner-down-right": phosphorIcon(ArrowElbowDownRightIcon),
  "corner-down-left": phosphorIcon(ArrowElbowDownLeftIcon),
  "panel-left": phosphorIcon(SidebarSimpleIcon),
  // Phosphor only draws the sidebar on the left; mirror it for the right.
  "panel-right": phosphorIcon(SidebarSimpleIcon, "-scale-x-100"),
  "chevrons-up-down": phosphorIcon(CaretUpDownIcon),
  "more-horizontal": phosphorIcon(DotsThreeIcon),
  "more-vertical": phosphorIcon(DotsThreeVerticalIcon),
  "calendar": phosphorIcon(CalendarBlankIcon),
  "folder": phosphorIcon(FolderSimpleIcon),
  "sliders-horizontal": phosphorIcon(SlidersHorizontalIcon),
};

const IconContext = createContext<Record<IconName, IconComponent> | null>(null);

/**
 * Returns a single icon component for the given name.
 * Falls back to the default (Phosphor) set if no provider is present.
 */
function useIcon(name: IconName): IconComponent {
  const icons = useContext(IconContext);
  return (icons ?? defaultIcons)[name];
}

/**
 * Returns the full icon map.
 * Falls back to the default (Phosphor) set if no provider is present.
 */
function useIcons(): Record<IconName, IconComponent> {
  const icons = useContext(IconContext);
  return icons ?? defaultIcons;
}

/**
 * Swap some or all icons for components from another library.
 * Names left out of `icons` keep their default (Phosphor) component.
 */
function IconProvider({
  children,
  icons,
}: {
  children: ReactNode;
  icons?: Partial<Record<IconName, IconComponent>>;
}) {
  const value = useMemo(() => ({ ...defaultIcons, ...icons }), [icons]);
  return <IconContext.Provider value={value}>{children}</IconContext.Provider>;
}

export { IconProvider, useIcon, useIcons };
