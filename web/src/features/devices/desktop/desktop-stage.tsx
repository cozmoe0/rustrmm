/*
 * The remote screen: hosts the renderer's canvas, scales it (fit or 1:1), composites the remote
 * cursor and turns mouse, wheel, keyboard and touch input into protocol messages.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { CursorCache, type CursorShape } from '@/lib/desktop/cursor'
import { KEY_SPECS, KeyTracker, MOUSE_BUTTON, WheelAccumulator, codeForKey, isPasteShortcut, keyMessage, mouseMessage, wheelToNotches, type KeyInput } from '@/lib/desktop/input'
import type { CursorPositionMessage, CursorShapeMessage } from '@/lib/desktop/protocol'
import { clientToRemote, layoutViewport, type ScaleMode, type Size } from '@/lib/desktop/viewport'
import { cn } from '@/lib/utils'
import type { DesktopSessionApi } from './use-desktop-session'

export interface DesktopStageHandle {
  focus(): void
  /** The focusable screen, for returning focus after toolbar menus close. */
  element(): HTMLElement | null
  /** Releases held keys and mouse buttons on the device. */
  releaseInput(): void
  cursorShape(message: CursorShapeMessage): void
  cursorPosition(message: CursorPositionMessage): void
  /** Opens the on-screen keyboard (touch devices). */
  openKeyboard(): void
  /** Sends a mouse event at the last pointer position, keeping an idle session alive. */
  nudge(): void
}

interface DesktopStageProps {
  session: DesktopSessionApi
  screen: Size | null
  mode: ScaleMode
  /** Input is captured only while streaming and not view-only. */
  interactive: boolean
  mapMetaToCtrl: boolean
  /** Fades the picture (an ended session); overlays stay crisp. */
  dimmed?: boolean
  onFocusChange?: (focused: boolean) => void
  children?: ReactNode
  className?: string
}

/** Touch: hold this long for a right click. */
const LONG_PRESS_MS = 550
/** Touch: movement that turns a tap into a drag. */
const TAP_SLOP = 9
/** Touch: two-finger travel per wheel notch. */
const PAN_PER_NOTCH = 36

interface TouchPoint {
  id: number
  startX: number
  startY: number
  x: number
  y: number
}

export const DesktopStage = forwardRef<DesktopStageHandle, DesktopStageProps>(function DesktopStage(
  { session, screen, mode, interactive, mapMetaToCtrl, dimmed, onFocusChange, children, className },
  ref,
) {
  const stageRef = useRef<HTMLDivElement>(null)
  const screenRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const cursorRef = useRef<HTMLCanvasElement>(null)
  const keyboardRef = useRef<HTMLTextAreaElement>(null)
  const [stageSize, setStageSize] = useState<Size>({ width: 0, height: 0 })
  const [dpr, setDpr] = useState(() => (typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1))

  const sessionRef = useRef(session)
  const interactiveRef = useRef(interactive)
  const screenSizeRef = useRef(screen)
  const mapMetaRef = useRef(mapMetaToCtrl)
  useEffect(() => {
    sessionRef.current = session
    interactiveRef.current = interactive
    screenSizeRef.current = screen
    mapMetaRef.current = mapMetaToCtrl
  })

  // ------------------------------------------------------------------ renderer canvas

  const { rendererVersion } = session.state
  useLayoutEffect(() => {
    const host = hostRef.current
    const renderer = session.getRenderer()
    if (!host || !renderer) return
    const canvas = renderer.canvas
    canvas.className = 'block h-full w-full select-none'
    host.appendChild(canvas)
    return () => {
      if (canvas.parentNode === host) host.removeChild(canvas)
    }
    // A new renderer replaces the canvas.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rendererVersion])

  // ------------------------------------------------------------------ layout

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const observer = new ResizeObserver(([entry]) => {
      const box = entry.contentRect
      setStageSize((prev) => (prev.width === Math.floor(box.width) && prev.height === Math.floor(box.height) ? prev : { width: Math.floor(box.width), height: Math.floor(box.height) }))
    })
    observer.observe(stage)
    const media = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
    const onDpr = () => setDpr(window.devicePixelRatio || 1)
    media.addEventListener('change', onDpr)
    return () => {
      observer.disconnect()
      media.removeEventListener('change', onDpr)
    }
  }, [])

  const layout = screen ? layoutViewport(stageSize, screen, mode, dpr) : null
  const scaleRef = useRef(1)

  // ------------------------------------------------------------------ cursor

  const cursorCache = useRef<CursorCache | null>(null)
  const cursor = useRef<{ shape: CursorShape | null; x: number; y: number; visible: boolean; inside: boolean; touch: boolean }>({
    shape: null,
    x: 0,
    y: 0,
    visible: false,
    inside: false,
    touch: false,
  })

  const drawCursor = useCallback(() => {
    const canvas = cursorRef.current
    const target = screenRef.current
    if (!canvas || !target) return
    const state = cursor.current
    const shape = state.shape
    const controlling = interactiveRef.current && state.inside && !state.touch
    // While controlling with a mouse, the local pointer wears the remote shape (no latency).
    target.style.cursor = controlling ? (state.visible ? (shape?.css ?? 'default') : 'none') : interactiveRef.current ? 'default' : 'default'
    const composite = Boolean(shape) && state.visible && (!controlling || !shape?.css)
    canvas.style.display = composite ? 'block' : 'none'
    if (!composite || !shape) return
    if (canvas.width !== shape.width || canvas.height !== shape.height || canvas.dataset.shape !== shape.image.dataset.key) {
      canvas.width = shape.width
      canvas.height = shape.height
      canvas.getContext('2d')?.drawImage(shape.image, 0, 0)
      canvas.dataset.shape = shape.image.dataset.key ?? ''
    }
    const scale = scaleRef.current
    canvas.style.width = `${shape.width * scale}px`
    canvas.style.height = `${shape.height * scale}px`
    canvas.style.transform = `translate(${(state.x - shape.hotX) * scale}px, ${(state.y - shape.hotY) * scale}px)`
  }, [])

  const layoutScale = layout?.scale ?? 1
  useEffect(() => {
    scaleRef.current = layoutScale
    drawCursor()
  }, [layoutScale, interactive, drawCursor])

  // ------------------------------------------------------------------ input state

  const keys = useRef(new KeyTracker())
  const wheel = useRef(new WheelAccumulator())
  const pointer = useRef({ x: 0, y: 0, buttons: 0, known: false })
  const frame = useRef(0)
  const pendingMove = useRef(false)
  const pasteArmed = useRef<number | null>(null)

  const send = (message: Parameters<DesktopSessionApi['sendInput']>[0]) => sessionRef.current.sendInput(message)

  const toRemote = (clientX: number, clientY: number) => {
    const target = screenRef.current
    const size = screenSizeRef.current
    if (!target || !size) return null
    return clientToRemote(clientX, clientY, target.getBoundingClientRect(), size)
  }

  const flush = useCallback(() => {
    frame.current = 0
    if (!pointer.current.known) return
    const notches = wheel.current.take()
    if (pendingMove.current || notches) {
      pendingMove.current = false
      sessionRef.current.sendInput(mouseMessage(pointer.current, pointer.current.buttons, notches))
    }
  }, [])

  const schedule = useCallback(() => {
    if (!frame.current) frame.current = requestAnimationFrame(flush)
  }, [flush])

  const releaseInput = useCallback(() => {
    if (frame.current) {
      cancelAnimationFrame(frame.current)
      flush()
    }
    for (const message of keys.current.releaseAll()) sessionRef.current.sendInput(message)
    if (pointer.current.buttons && pointer.current.known) {
      pointer.current.buttons = 0
      sessionRef.current.sendInput(mouseMessage(pointer.current, 0))
    }
  }, [flush])

  useEffect(() => {
    if (!interactive) releaseInput()
  }, [interactive, releaseInput])

  useEffect(() => () => cancelAnimationFrame(frame.current), [])

  // Releasing on blur avoids stuck modifiers after Alt+Tab or a window switch on this computer.
  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === 'hidden') releaseInput()
    }
    window.addEventListener('blur', releaseInput)
    document.addEventListener('visibilitychange', onHidden)
    return () => {
      window.removeEventListener('blur', releaseInput)
      document.removeEventListener('visibilitychange', onHidden)
    }
  }, [releaseInput])

  // ------------------------------------------------------------------ mouse and pen

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'touch') return onTouchDown(event)
    stageRef.current?.focus({ preventScroll: true })
    if (!interactiveRef.current) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const point = toRemote(event.clientX, event.clientY)
    if (!point) return
    pointer.current = { ...point, buttons: event.buttons, known: true }
    pendingMove.current = false
    send(mouseMessage(point, event.buttons))
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'touch') return onTouchMove(event)
    const point = toRemote(event.clientX, event.clientY)
    if (!point) return
    cursor.current.inside = true
    if (!interactiveRef.current) return
    const buttonsChanged = event.buttons !== pointer.current.buttons
    pointer.current = { ...point, buttons: event.buttons, known: true }
    if (buttonsChanged) {
      // A button pressed or released during a move (chorded clicks) is sent at once.
      pendingMove.current = false
      send(mouseMessage(point, event.buttons))
    } else {
      pendingMove.current = true
      schedule()
    }
  }

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'touch') return onTouchUp(event)
    if (!interactiveRef.current) return
    event.preventDefault()
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    const point = toRemote(event.clientX, event.clientY) ?? pointer.current
    pointer.current = { x: point.x, y: point.y, buttons: event.buttons, known: true }
    pendingMove.current = false
    send(mouseMessage(point, event.buttons))
  }

  useEffect(() => {
    const target = screenRef.current
    if (!target) return
    const onWheel = (event: WheelEvent) => {
      if (!interactiveRef.current) return
      event.preventDefault()
      const point = toRemote(event.clientX, event.clientY)
      if (!point) return
      pointer.current = { ...point, buttons: pointer.current.buttons, known: true }
      wheel.current.add(wheelToNotches(event))
      schedule()
    }
    // Back/forward mouse buttons would navigate the console away.
    const onAux = (event: MouseEvent) => {
      if (interactiveRef.current) event.preventDefault()
    }
    target.addEventListener('wheel', onWheel, { passive: false })
    target.addEventListener('auxclick', onAux)
    target.addEventListener('mouseup', onAux)
    return () => {
      target.removeEventListener('wheel', onWheel)
      target.removeEventListener('auxclick', onAux)
      target.removeEventListener('mouseup', onAux)
    }
  }, [schedule])

  // ------------------------------------------------------------------ touch

  const touches = useRef(new Map<number, TouchPoint>())
  const touchState = useRef<{ mode: 'none' | 'tap' | 'drag' | 'pan' | 'done'; timer: number; startedAt: number; panY: number; panX: number; moved: number }>({
    mode: 'none',
    timer: 0,
    startedAt: 0,
    panY: 0,
    panX: 0,
    moved: 0,
  })

  const click = (point: { x: number; y: number }, bit: number) => {
    pointer.current = { ...point, buttons: 0, known: true }
    send(mouseMessage(point, 0))
    send(mouseMessage(point, bit))
    send(mouseMessage(point, 0))
  }

  const midpoint = () => {
    const list = [...touches.current.values()]
    const x = list.reduce((sum, item) => sum + item.x, 0) / list.length
    const y = list.reduce((sum, item) => sum + item.y, 0) / list.length
    return { x, y }
  }

  function onTouchDown(event: React.PointerEvent<HTMLDivElement>) {
    cursor.current.touch = true
    if (!interactiveRef.current) return
    event.currentTarget.setPointerCapture(event.pointerId)
    touches.current.set(event.pointerId, { id: event.pointerId, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY })
    const state = touchState.current
    window.clearTimeout(state.timer)
    if (touches.current.size === 1) {
      state.mode = 'tap'
      state.startedAt = performance.now()
      state.moved = 0
      const startX = event.clientX
      const startY = event.clientY
      state.timer = window.setTimeout(() => {
        if (state.mode !== 'tap') return
        const point = toRemote(startX, startY)
        if (point) click(point, MOUSE_BUTTON.right)
        state.mode = 'done'
        navigator.vibrate?.(12)
      }, LONG_PRESS_MS)
    } else if (touches.current.size === 2) {
      if (state.mode === 'drag' && pointer.current.buttons) {
        pointer.current.buttons = 0
        send(mouseMessage(pointer.current, 0))
      }
      state.mode = 'pan'
      state.startedAt = performance.now()
      state.panX = 0
      state.panY = 0
      state.moved = 0
    }
  }

  function onTouchMove(event: React.PointerEvent<HTMLDivElement>) {
    const touch = touches.current.get(event.pointerId)
    if (!touch || !interactiveRef.current) return
    const before = touches.current.size === 2 ? midpoint() : null
    touch.x = event.clientX
    touch.y = event.clientY
    const state = touchState.current
    if (state.mode === 'pan' && before) {
      const after = midpoint()
      const dx = after.x - before.x
      const dy = after.y - before.y
      state.moved += Math.abs(dx) + Math.abs(dy)
      // Natural scrolling: moving the fingers up scrolls the content down.
      wheel.current.add({ x: -dx / PAN_PER_NOTCH, y: -dy / PAN_PER_NOTCH })
      const point = toRemote(after.x, after.y)
      if (point) pointer.current = { ...point, buttons: 0, known: true }
      schedule()
      return
    }
    const distance = Math.hypot(touch.x - touch.startX, touch.y - touch.startY)
    if (state.mode === 'tap' && distance > TAP_SLOP) {
      window.clearTimeout(state.timer)
      if (mode === 'actual') {
        // 1:1 lets the stage scroll natively; the browser cancels this pointer.
        state.mode = 'done'
        return
      }
      state.mode = 'drag'
      const start = toRemote(touch.startX, touch.startY)
      if (start) {
        pointer.current = { ...start, buttons: MOUSE_BUTTON.left, known: true }
        send(mouseMessage(start, 0))
        send(mouseMessage(start, MOUSE_BUTTON.left))
      }
    }
    if (state.mode === 'drag') {
      const point = toRemote(touch.x, touch.y)
      if (point) {
        pointer.current = { ...point, buttons: MOUSE_BUTTON.left, known: true }
        pendingMove.current = true
        schedule()
      }
    }
  }

  function onTouchUp(event: React.PointerEvent<HTMLDivElement>) {
    const touch = touches.current.get(event.pointerId)
    touches.current.delete(event.pointerId)
    if (!touch || !interactiveRef.current) return
    const state = touchState.current
    window.clearTimeout(state.timer)
    const cancelled = event.type === 'pointercancel'
    if (state.mode === 'tap' && !cancelled) {
      const point = toRemote(touch.startX, touch.startY)
      if (point) click(point, MOUSE_BUTTON.left)
      state.mode = 'none'
    } else if (state.mode === 'drag') {
      flush()
      pointer.current.buttons = 0
      send(mouseMessage(pointer.current, 0))
      state.mode = 'none'
    } else if (state.mode === 'pan') {
      // A quick two-finger tap is a right click.
      if (!cancelled && touches.current.size === 1 && state.moved < TAP_SLOP && performance.now() - state.startedAt < 300) {
        const other = [...touches.current.values()][0]
        const point = toRemote((touch.x + other.x) / 2, (touch.y + other.y) / 2)
        if (point) click(point, MOUSE_BUTTON.right)
      }
      if (touches.current.size === 0) state.mode = 'none'
      else state.mode = 'done'
    }
    if (touches.current.size === 0 && state.mode === 'done') state.mode = 'none'
  }

  // ------------------------------------------------------------------ keyboard

  const mapped = (event: KeyInput): KeyInput => {
    if (!mapMetaRef.current) return event
    if (event.code === 'MetaLeft') return { code: 'ControlLeft', key: 'Control', location: 1 }
    if (event.code === 'MetaRight') return { code: 'ControlRight', key: 'Control', location: 2 }
    return event
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!interactiveRef.current || event.nativeEvent.isComposing) return
    if (isPasteShortcut(event)) {
      // Let the browser raise a paste event so the local clipboard can travel with the shortcut.
      window.clearTimeout(pasteArmed.current ?? 0)
      pasteArmed.current = window.setTimeout(() => {
        pasteArmed.current = null
        pasteCombo()
      }, 160)
      event.stopPropagation()
      return
    }
    event.preventDefault()
    event.stopPropagation()
    send(keys.current.down(mapped({ code: event.code, key: event.key, location: event.location })))
  }

  const onKeyUp = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!interactiveRef.current) return
    event.preventDefault()
    event.stopPropagation()
    const message = keys.current.up(mapped({ code: event.code, key: event.key, location: event.location }))
    if (message) send(message)
  }

  /** Ctrl+V on the device, reusing a Ctrl that is already held. */
  function pasteCombo() {
    const ctrlHeld = keys.current.isHeld('ControlLeft') || keys.current.isHeld('ControlRight')
    if (!ctrlHeld) send(keyMessage(KEY_SPECS.ControlLeft, true))
    send(keyMessage(KEY_SPECS.KeyV, true))
    send(keyMessage(KEY_SPECS.KeyV, false))
    if (!ctrlHeld) send(keyMessage(KEY_SPECS.ControlLeft, false))
  }

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      if (document.activeElement !== stageRef.current || pasteArmed.current === null) return
      event.preventDefault()
      window.clearTimeout(pasteArmed.current)
      pasteArmed.current = null
      const text = event.clipboardData?.getData('text/plain') ?? ''
      if (text) sessionRef.current.sendClipboard(text)
      pasteCombo()
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
    // pasteCombo reads refs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // On-screen keyboard (touch): a hidden textarea collects text and named keys.
  const SENTINEL = ' '
  const resetKeyboard = () => {
    const field = keyboardRef.current
    if (!field) return
    field.value = SENTINEL
    field.setSelectionRange(1, 1)
  }

  const onKeyboardInput = (event: React.FormEvent<HTMLTextAreaElement>) => {
    const native = event.nativeEvent as InputEvent
    if (native.isComposing) return
    const field = event.currentTarget
    if (native.inputType === 'deleteContentBackward' || field.value.length < SENTINEL.length) {
      sessionRef.current.sendKeys([keyMessage({ code: 'Backspace', key: 'Backspace' }, true), keyMessage({ code: 'Backspace', key: 'Backspace' }, false)])
    } else {
      const text = field.value.slice(SENTINEL.length)
      if (text) sessionRef.current.sendText(text)
    }
    resetKeyboard()
  }

  const onKeyboardComposition = (event: React.CompositionEvent<HTMLTextAreaElement>) => {
    if (event.data) sessionRef.current.sendText(event.data)
    resetKeyboard()
  }

  const onKeyboardKey = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const code = event.code && event.code !== 'Unidentified' ? event.code : codeForKey(event.key)
    if (!['Enter', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Delete', 'Home', 'End', 'PageUp', 'PageDown'].includes(code)) return
    event.preventDefault()
    sessionRef.current.sendKeys([keyMessage({ code, key: event.key }, true), keyMessage({ code, key: event.key }, false)])
  }

  // ------------------------------------------------------------------ handle

  useImperativeHandle(
    ref,
    () => ({
      focus: () => stageRef.current?.focus({ preventScroll: true }),
      element: () => stageRef.current,
      releaseInput,
      cursorShape: (message) => {
        cursorCache.current ??= new CursorCache()
        const shape = cursorCache.current.get(message)
        if (!shape.image.dataset.key) shape.image.dataset.key = `${message.w}x${message.h}:${Math.random().toString(36).slice(2)}`
        cursor.current.shape = shape
        drawCursor()
      },
      cursorPosition: (message) => {
        cursor.current.x = message.x
        cursor.current.y = message.y
        cursor.current.visible = message.visible
        drawCursor()
      },
      openKeyboard: () => {
        resetKeyboard()
        keyboardRef.current?.focus({ preventScroll: true })
      },
      nudge: () => {
        if (pointer.current.known) sessionRef.current.sendInput(mouseMessage(pointer.current, pointer.current.buttons))
        else if (screenSizeRef.current) {
          const center = { x: Math.floor(screenSizeRef.current.width / 2), y: Math.floor(screenSizeRef.current.height / 2) }
          sessionRef.current.sendInput(mouseMessage(center, 0))
        }
      },
    }),
    [drawCursor, releaseInput],
  )

  const overflow = Boolean(layout?.overflows)

  return (
    <div className={cn('relative flex min-h-0 flex-1 flex-col', className)}>
      <div
        ref={stageRef}
        tabIndex={0}
        role="application"
        aria-roledescription="Remote desktop"
        aria-label={interactive ? 'Remote screen. Keyboard and mouse input go to the device.' : 'Remote screen (view only)'}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onFocus={() => onFocusChange?.(true)}
        onBlur={() => {
          onFocusChange?.(false)
          releaseInput()
        }}
        className={cn(
          'relative min-h-0 flex-1 transition-[opacity,filter] duration-500 outline-none',
          overflow ? 'overflow-auto' : 'overflow-hidden',
          dimmed && 'opacity-55 saturate-[0.4]',
        )}
      >
        <div
          className={cn('flex min-h-full min-w-full', overflow ? 'items-start justify-start' : 'items-center justify-center')}
          style={overflow && layout ? { width: Math.max(layout.width, stageSize.width), height: Math.max(layout.height, stageSize.height) } : undefined}
        >
          <div
            ref={screenRef}
            className={cn(
              'relative shrink-0 overflow-hidden bg-[#0b0d10] shadow-[0_18px_60px_-20px_rgb(0_0_0/0.7),0_0_0_1px_rgb(255_255_255/0.06)]',
              !layout && 'invisible',
              interactive ? (mode === 'fit' ? 'touch-none' : 'touch-pan-x touch-pan-y') : '',
            )}
            style={layout ? { width: layout.width, height: layout.height } : { width: 0, height: 0 }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onPointerEnter={(event) => {
              cursor.current.inside = true
              cursor.current.touch = event.pointerType === 'touch'
              drawCursor()
            }}
            onPointerLeave={() => {
              cursor.current.inside = false
              drawCursor()
            }}
            onContextMenu={(event) => event.preventDefault()}
            onDragStart={(event) => event.preventDefault()}
          >
            <div ref={hostRef} className="absolute inset-0" />
            <canvas ref={cursorRef} aria-hidden="true" className="pointer-events-none absolute top-0 left-0 hidden origin-top-left will-change-transform" />
          </div>
        </div>
        <textarea
          ref={keyboardRef}
          aria-label="On-screen keyboard input"
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          defaultValue={SENTINEL}
          onInput={onKeyboardInput}
          onCompositionEnd={onKeyboardComposition}
          onKeyDown={onKeyboardKey}
          className="pointer-events-none fixed bottom-0 left-0 h-px w-px resize-none opacity-0"
          tabIndex={-1}
        />
      </div>
      {children}
    </div>
  )
})
