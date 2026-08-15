import { invoke, isTauri } from '@tauri-apps/api/core'

export type CaptureResult = {
  dataUrl: string
  cursor?: DesktopCursorPoint | null
}

export const QUICK_EDITOR_WINDOW_LABEL = 'quick-editor'

export type CaptureErrorCode = 'CaptureCancelled' | 'CaptureFailed'

export type DesktopCursorPoint = {
  x: number
  y: number
}

type CaptureErrorPayload = {
  code?: string
  message?: string
}

type CaptureReadyPayload = {
  dataUrl?: string
  cursor?: DesktopCursorPoint | null
}

const CAPTURE_READY_EVENT = 'capture://ready'
const QUICK_EDITOR_CAPTURE_READY_EVENT = 'capture://quick-editor-ready'
const CAPTURE_ERROR_EVENT = 'capture://error'

export class CaptureError extends Error {
  readonly code: CaptureErrorCode

  constructor(code: CaptureErrorCode, message: string) {
    super(message)
    this.name = 'CaptureError'
    this.code = code
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const isDesktopCursorPoint = (value: unknown): value is DesktopCursorPoint => {
  if (!isObject(value)) {
    return false
  }

  return typeof value.x === 'number' && typeof value.y === 'number'
}

const isTauriRuntime = (): boolean => {
  if (typeof window === 'undefined') {
    return false
  }

  try {
    return isTauri()
  } catch {
    return '__TAURI_INTERNALS__' in window
  }
}

const blobToDataUrl = async (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result)
        return
      }

      reject(new CaptureError('CaptureFailed', 'Could not decode image data'))
    }
    reader.onerror = () => reject(new CaptureError('CaptureFailed', reader.error?.message ?? 'Could not decode image data'))
    reader.readAsDataURL(blob)
  })

const parseCaptureErrorPayload = (error: unknown): CaptureErrorPayload => {
  if (isObject(error)) {
    return {
      code: typeof error.code === 'string' ? error.code : undefined,
      message: typeof error.message === 'string' ? error.message : undefined,
    }
  }

  if (typeof error === 'string') {
    try {
      const parsed = JSON.parse(error)
      if (isObject(parsed)) {
        return {
          code: typeof parsed.code === 'string' ? parsed.code : undefined,
          message: typeof parsed.message === 'string' ? parsed.message : undefined,
        }
      }
    } catch {
      return { message: error }
    }

    return { message: error }
  }

  if (error instanceof Error) {
    return { message: error.message }
  }

  return {}
}

const looksLikeInvokeUnavailableError = (error: unknown): boolean => {
  const payload = parseCaptureErrorPayload(error)
  const sourceMessage = typeof payload.message === 'string' ? payload.message : String(error ?? '')
  const message = sourceMessage.toLowerCase()

  return (
    message.includes('__tauri_internals__') ||
    message.includes('is not a function') ||
    message.includes('cannot read') && message.includes('invoke') ||
    message.includes('tauri') && message.includes('not available')
  )
}

const normalizeCaptureError = (error: unknown): CaptureError => {
  const parsed = parseCaptureErrorPayload(error)

  if (parsed.code === 'CaptureCancelled') {
    return new CaptureError('CaptureCancelled', parsed.message ?? 'Capture cancelled')
  }

  if (parsed.code === 'CaptureFailed') {
    return new CaptureError('CaptureFailed', parsed.message ?? 'Capture failed')
  }

  return new CaptureError('CaptureFailed', parsed.message ?? 'Capture failed')
}

const normalizeCaptureReadyPayload = (payload: unknown): CaptureResult | null => {
  if (typeof payload === 'string') {
    return {
      dataUrl: payload,
      cursor: null,
    }
  }

  if (!isObject(payload)) {
    return null
  }

  const typedPayload = payload as CaptureReadyPayload
  if (typeof typedPayload.dataUrl !== 'string') {
    return null
  }

  return {
    dataUrl: typedPayload.dataUrl,
    cursor: isDesktopCursorPoint(typedPayload.cursor) ? typedPayload.cursor : null,
  }
}

const captureRegionWeb = async (): Promise<CaptureResult> => {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new CaptureError('CaptureFailed', 'Screen capture is not supported in this browser')
  }

  let stream: MediaStream | null = null

  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: 1,
      },
      audio: false,
    })

    const track = stream.getVideoTracks()[0]
    if (!track) {
      throw new CaptureError('CaptureFailed', 'No video track in captured stream')
    }

    const video = document.createElement('video')
    video.srcObject = stream
    video.playsInline = true
    video.muted = true
    await video.play()

    const captureCanvas = document.createElement('canvas')
    captureCanvas.width = video.videoWidth
    captureCanvas.height = video.videoHeight

    const context = captureCanvas.getContext('2d')
    if (!context) {
      throw new CaptureError('CaptureFailed', 'Could not create capture context')
    }

    context.drawImage(video, 0, 0, captureCanvas.width, captureCanvas.height)

    const blob = await new Promise<Blob | null>((resolve) => {
      captureCanvas.toBlob((blobData) => {
        resolve(blobData)
      }, 'image/png')
    })

    if (!blob) {
      throw new CaptureError('CaptureFailed', 'Could not encode capture as PNG')
    }

    const dataUrl = await blobToDataUrl(blob)
    return { dataUrl }
  } catch (error) {
    if (error instanceof CaptureError) {
      throw error
    }

    if (error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'AbortError')) {
      throw new CaptureError('CaptureCancelled', 'Capture cancelled')
    }

    throw new CaptureError('CaptureFailed', error instanceof Error ? error.message : 'Screen capture failed')
  } finally {
    stream?.getTracks().forEach((track) => track.stop())
  }
}

const captureRegionDesktop = async (): Promise<CaptureResult> => {
  try {
    const payload = await invoke<unknown>('capture_region')
    const result = normalizeCaptureReadyPayload(payload)
    if (!result) {
      throw new CaptureError('CaptureFailed', 'Invalid capture payload received from desktop backend')
    }

    return result
  } catch (error) {
    if (looksLikeInvokeUnavailableError(error)) {
      throw error
    }

    throw normalizeCaptureError(error)
  }
}

export const captureRegion = async (): Promise<CaptureResult> => {
  if (isTauriRuntime()) {
    return captureRegionDesktop()
  }

  // In mixed runtimes, try native first and only fallback to web when invoke is unavailable.
  try {
    return await captureRegionDesktop()
  } catch (error) {
    if (looksLikeInvokeUnavailableError(error)) {
      return captureRegionWeb()
    }

    throw normalizeCaptureError(error)
  }
}

export const openQuickCaptureWindow = async (result: CaptureResult): Promise<void> => {
  await invoke('open_quick_capture_window', {
    dataUrl: result.dataUrl,
    cursor: result.cursor ?? null,
  })
}

export const takePendingQuickCapture = async (): Promise<CaptureResult | null> => {
  const payload = await invoke<unknown>('take_pending_quick_capture')
  return normalizeCaptureReadyPayload(payload)
}

export const listenForDesktopCapture = async (
  onReady: (result: CaptureResult) => void,
  onError: (error: CaptureError) => void,
): Promise<(() => void) | null> => {
  if (!isTauriRuntime()) {
    return null
  }

  const { listen } = await import('@tauri-apps/api/event')

  const unlistenReady = await listen<unknown>(CAPTURE_READY_EVENT, (event) => {
    const result = normalizeCaptureReadyPayload(event.payload)
    if (!result) {
      onError(new CaptureError('CaptureFailed', 'Invalid capture payload received from desktop backend'))
      return
    }

    onReady(result)
  })

  const unlistenError = await listen<CaptureErrorPayload>(CAPTURE_ERROR_EVENT, (event) => {
    onError(normalizeCaptureError(event.payload))
  })

  return () => {
    unlistenReady()
    unlistenError()
  }
}

export const listenForQuickEditorCapture = async (
  onReady: (result: CaptureResult) => void,
): Promise<(() => void) | null> => {
  if (!isTauriRuntime()) {
    return null
  }

  const { listen } = await import('@tauri-apps/api/event')

  const unlistenReady = await listen<unknown>(QUICK_EDITOR_CAPTURE_READY_EVENT, (event) => {
    const result = normalizeCaptureReadyPayload(event.payload)
    if (result) {
      onReady(result)
    }
  })

  return () => {
    unlistenReady()
  }
}
