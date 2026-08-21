import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { invoke, isTauri } from '@tauri-apps/api/core'
import './FrozenCapture.css'

/**
 * Frozen-screen region selector.
 *
 * Instead of macOS's live `screencapture -i`, the backend grabs a still of the
 * display, hides the app, and shows this overlay full-screen on top of it. The
 * user drags a rectangle over the frozen image; on release the region is
 * cropped from the still and handed to the quick editor. Because the still was
 * taken with the app hidden, the editor never ends up in its own shot, and
 * moving content (video, menus) stays put while you aim.
 */

type FrozenPayload = {
  imageDataUrl: string
  width: number
  height: number
  scaleFactor: number
  cursor: { x: number; y: number } | null
}

type Point = { x: number; y: number }

const MIN_SELECTION = 6

const normalize = (a: Point, b: Point) => {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return { x, y, width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) }
}

export default function FrozenCapture() {
  const [payload, setPayload] = useState<FrozenPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [start, setStart] = useState<Point | null>(null)
  const [current, setCurrent] = useState<Point | null>(null)
  const [hover, setHover] = useState<Point | null>(null)
  const draggingRef = useRef(false)
  const committedRef = useRef(false)

  // Pull the frozen still the backend stashed for this overlay window.
  useEffect(() => {
    let cancelled = false

    const load = async () => {
      if (!isTauri()) {
        // Browser preview: load a fixture so the selection UI can be exercised.
        const params = new URLSearchParams(window.location.search)
        if (params.get('overlayTest') === '1') {
          const img = new Image()
          img.onload = () =>
            !cancelled &&
            setPayload({
              imageDataUrl: '/__test-fixture.png',
              width: img.naturalWidth,
              height: img.naturalHeight,
              scaleFactor: 2,
              cursor: null,
            })
          img.src = '/__test-fixture.png'
        }
        return
      }

      try {
        const result = await invoke<FrozenPayload | null>('take_pending_frozen_capture')
        if (!cancelled) {
          if (result) {
            setPayload(result)
          } else {
            setError('No capture is pending.')
          }
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not load the capture.')
        }
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [])

  const cancel = useCallback(async () => {
    if (committedRef.current) {
      return
    }
    committedRef.current = true
    if (isTauri()) {
      await invoke('cancel_frozen_capture').catch(() => {})
    }
  }, [])

  const confirm = useCallback(
    async (rect: { x: number; y: number; width: number; height: number }) => {
      if (committedRef.current || !payload) {
        return
      }

      const scale = payload.scaleFactor || 1
      const sx = Math.round(rect.x * scale)
      const sy = Math.round(rect.y * scale)
      const sw = Math.round(rect.width * scale)
      const sh = Math.round(rect.height * scale)
      if (sw < 1 || sh < 1) {
        return
      }

      committedRef.current = true

      const source = new Image()
      source.src = payload.imageDataUrl
      await source.decode().catch(() => {})

      const canvas = document.createElement('canvas')
      canvas.width = sw
      canvas.height = sh
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        committedRef.current = false
        return
      }
      ctx.drawImage(source, sx, sy, sw, sh, 0, 0, sw, sh)
      const dataUrl = canvas.toDataURL('image/png')

      if (!isTauri()) {
        // Preview: show the crop so the math can be checked by eye.
        window.dispatchEvent(new CustomEvent('frozen-preview', { detail: dataUrl }))
        committedRef.current = false
        return
      }

      await invoke('finish_frozen_capture', { dataUrl, cursor: payload.cursor }).catch((err) => {
        committedRef.current = false
        setError(err instanceof Error ? err.message : 'Could not open the editor.')
      })
    },
    [payload],
  )

  // Keyboard: Escape cancels.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        void cancel()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [cancel])

  const startRef = useRef<Point | null>(null)

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      if (event.button !== 0) {
        return
      }
      const p = { x: event.clientX, y: event.clientY }
      draggingRef.current = true
      startRef.current = p
      setStart(p)
      setCurrent(p)

      // Track move/up on window so a release outside the element, or one the
      // browser routes elsewhere, still ends the drag.
      const onMove = (move: PointerEvent) => {
        setCurrent({ x: move.clientX, y: move.clientY })
      }
      const onUp = (up: PointerEvent) => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        draggingRef.current = false
        const from = startRef.current
        if (from) {
          const rect = normalize(from, { x: up.clientX, y: up.clientY })
          if (rect.width >= MIN_SELECTION && rect.height >= MIN_SELECTION) {
            void confirm(rect)
            return
          }
        }
        void cancel()
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [cancel, confirm],
  )

  const onPointerMove = useCallback((event: React.PointerEvent) => {
    if (!draggingRef.current) {
      setHover({ x: event.clientX, y: event.clientY })
    }
  }, [])

  const selection = useMemo(
    () => (start && current ? normalize(start, current) : null),
    [start, current],
  )

  if (error) {
    return (
      <div className="frozen-root frozen-error" onPointerDown={() => void cancel()}>
        <p>{error}</p>
        <span>Press Esc to dismiss.</span>
      </div>
    )
  }

  if (!payload) {
    return <div className="frozen-root frozen-blank" />
  }

  const scale = payload.scaleFactor || 1
  const badge = selection
    ? `${Math.round(selection.width * scale)} × ${Math.round(selection.height * scale)}`
    : null

  return (
    <div
      className={`frozen-root ${selection ? 'has-selection' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      style={{ backgroundImage: `url(${payload.imageDataUrl})` }}
    >
      {/* Crosshair before a drag starts. */}
      {!selection && hover && (
        <>
          <div className="frozen-crosshair-h" style={{ top: hover.y }} />
          <div className="frozen-crosshair-v" style={{ left: hover.x }} />
        </>
      )}

      {/* Four dim panels around the selection reveal the bright region inside. */}
      {selection ? (
        <>
          <div className="frozen-dim" style={{ top: 0, left: 0, right: 0, height: selection.y }} />
          <div
            className="frozen-dim"
            style={{ top: selection.y + selection.height, left: 0, right: 0, bottom: 0 }}
          />
          <div
            className="frozen-dim"
            style={{ top: selection.y, left: 0, width: selection.x, height: selection.height }}
          />
          <div
            className="frozen-dim"
            style={{
              top: selection.y,
              left: selection.x + selection.width,
              right: 0,
              height: selection.height,
            }}
          />
          <div
            className="frozen-selection"
            style={{
              top: selection.y,
              left: selection.x,
              width: selection.width,
              height: selection.height,
            }}
          />
          {badge && (
            <div
              className="frozen-badge"
              style={{ top: Math.max(6, selection.y - 26), left: selection.x }}
            >
              {badge}
            </div>
          )}
        </>
      ) : (
        <div className="frozen-dim frozen-dim-full" />
      )}

      {!selection && (
        <div className="frozen-hint">Drag to select · Esc to cancel</div>
      )}
    </div>
  )
}
