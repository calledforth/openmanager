# Fluid Functionalism (vendored)

Components from [Fluid Functionalism](https://www.fluidfunctionalism.com)
([source](https://github.com/mickadesign/fluid-functionalism)), pulled from its
shadcn registry at commit `b3587bd` (2026-09-14). They are the same components
the Tend app vendors.

Treat this folder as third-party code: re-pull rather than hand-edit. It is
excluded from ESLint and Prettier. Wrappers that adapt these components to
OpenManager live outside this folder.

```sh
node packages/app-core/scripts/vendor-fluid.mjs
```

The script rewrites the registry's `@/` imports to relative paths. Tokens and
utilities the components read (`bg-surface-*`, `bg-hover`, `text-faint`,
`text-caption`, scroll fades, …) live in `src/styles/fluid.css`.

## Local edits to re-apply after a pull

These are Tend's edits, kept so the look matches Tend:

- `ui/dialog.tsx`: renders in the same commit that opens it
  (`if (!mounted && !open) return null`), and uses a lighter scrim
  (`bg-black/15 dark:bg-black/55` instead of `bg-black/40 dark:bg-black/80`).
- `ui/command-menu.tsx`: items accept `keepOpen` so picking a row can leave
  the menu open, and the list has hairlines but no scroll fade
  (`[scroll-timeline-name:--sf-scroller]` instead of
  `[--scroll-fade-size:32px] scroll-fade`).
