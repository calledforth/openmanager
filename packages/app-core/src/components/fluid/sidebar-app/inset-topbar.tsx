"use client";

import { type ReactNode } from "react";
import { SidebarTrigger, useSidebar } from "../ui/sidebar";
import { cn } from "../lib/utils";

// ---------------------------------------------------------------------------
// The main region's topbar: a slim strip for the trigger and whatever the
// host puts beside it (a title trail). While the sidebar is only PEEKED the
// trigger hides (the overlay covers it anyway); after a pin it fades back in
// slightly late, so it appears at its settled position instead of riding the
// inset's slide.
// ---------------------------------------------------------------------------

export function SidebarInsetTopbar({
  children,
  className,
}: {
  children?: ReactNode;
  className?: string;
}) {
  const { isPeeking } = useSidebar();
  return (
    <header
      className={cn("flex h-9 shrink-0 items-center gap-1.5 px-1", className)}
    >
      {/* Compact, so the bar stays slim; the glyph keeps the rail's 16px. */}
      <SidebarTrigger
        size="icon-compact"
        className={`[&_svg]:size-4 transition-opacity delay-200 duration-160 ${
          isPeeking ? "opacity-0" : "opacity-100"
        }`}
      />
      {children}
    </header>
  );
}
