import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

export type MenuCoords = {
  left: number
  top?: number
  bottom?: number
  width: number
}

export type MenuPlacement = 'above' | 'below'

type UsePortaledMenuOptions = {
  placement?: MenuPlacement
  minWidth?: number
  align?: 'start' | 'center' | 'end'
  deps?: unknown[]
}

export function usePortaledMenu({
  placement = 'above',
  minWidth = 220,
  align = 'start',
  deps = [],
}: UsePortaledMenuOptions = {}) {
  const [open, setOpen] = useState(false)
  const [menuCoords, setMenuCoords] = useState<MenuCoords | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])
  const toggle = useCallback(() => setOpen((current) => !current), [])

  const updateMenuCoords = useCallback(() => {
    const el = triggerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const width = Math.max(minWidth, rect.width)
    let left = rect.left
    if (align === 'center') left = rect.left + rect.width / 2 - width / 2
    if (align === 'end') left = rect.right - width
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8))
    const gap = 6

    if (placement === 'below') {
      setMenuCoords({
        left,
        top: rect.bottom + gap,
        width,
      })
      return
    }

    setMenuCoords({
      left,
      bottom: window.innerHeight - rect.top + gap,
      width,
    })
  }, [align, minWidth, placement])

  useLayoutEffect(() => {
    if (!open) {
      setMenuCoords(null)
      return
    }
    updateMenuCoords()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- open + explicit deps drive reposition
  }, [open, updateMenuCoords, ...deps])

  useEffect(() => {
    if (!open) return
    const onResizeOrScroll = () => updateMenuCoords()
    window.addEventListener('resize', onResizeOrScroll)
    window.addEventListener('scroll', onResizeOrScroll, true)
    return () => {
      window.removeEventListener('resize', onResizeOrScroll)
      window.removeEventListener('scroll', onResizeOrScroll, true)
    }
  }, [open, updateMenuCoords])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      const t = e.target as Node
      if (wrapRef.current?.contains(t)) return
      if (menuRef.current?.contains(t)) return
      close()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open, close])

  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, close])

  return {
    open,
    setOpen,
    toggle,
    close,
    menuCoords,
    wrapRef,
    triggerRef,
    menuRef,
  }
}
