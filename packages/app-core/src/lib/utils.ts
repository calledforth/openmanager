import { type ClassValue, clsx } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

// The `text-ui-*` steps (globals.css) are font sizes, but tailwind-merge
// cannot know that for custom names: it reads any `text-<word>` it does not
// recognize as a colour, so cn('text-ui-sm', 'text-[var(--basis-text)]')
// silently dropped the size. Same fix as fluid/lib/utils.ts.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': ['text-ui-2xs', 'text-ui-xs', 'text-ui-sm', 'text-ui-md', 'text-ui-base'],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
