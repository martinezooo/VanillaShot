import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import {
  ArrowRight,
  Check,
  CircleHelp,
  Copy,
  Crop,
  Crosshair,
  Eye,
  EyeOff,
  Film,
  FolderOpen,
  Highlighter,
  Mic,
  MousePointer2,
  Play,
  ScanText,
  Slash,
  Square,
  SquareDashed,
  Trash2,
  Type,
  Undo2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { createWorker, type Bbox, type Block, type LoggerMessage, type Word } from 'tesseract.js'
import './App.css'
import {
  CaptureError,
  captureRegion,
  QUICK_EDITOR_WINDOW_LABEL,
  listenForDesktopCapture,
  listenForQuickEditorCapture,
  openQuickCaptureWindow,
  takePendingQuickCapture,
  type DesktopCursorPoint,
} from './lib/capture'
import { scanCodesFromImage, type CodeRect, type DetectedCode } from './lib/codes'
import { isSensitiveToken } from './lib/sensitive'
import {
  getMemoryFrame,
  openMemoryPathInFinder,
  getMemoryStatus,
  getMemoryTimeline,
  startMemoryRecording,
  stopMemoryRecording,
  type MemoryFrame,
  type MemoryStatus,
} from './lib/memory'

type Tool =
  | 'select'
  | 'crop'
  | 'ocr-select'
  | 'arrow'
  | 'border'
  | 'blur'
  | 'pixelate'
  | 'blackout'
  | 'highlight'
  | 'strike'
  | 'text'

type Point = {
  x: number
  y: number
}

type RectAnnotationType = 'blur' | 'blackout' | 'highlight' | 'pixelate' | 'border'

type ArrowStyle = 'classic' | 'double' | 'line' | 'curved'

type BaseAnnotation = {
  id: string
  createdAt: number
}

type RectAnnotation = BaseAnnotation & {
  type: RectAnnotationType
  x: number
  y: number
  width: number
  height: number
  fillColor?: string
  borderColor?: string
  borderWidth?: number
  cellSize?: number
  randomSeed?: number
}

type StrikeAnnotation = BaseAnnotation & {
  type: 'strike'
  x1: number
  y1: number
  x2: number
  y2: number
  color: string
}

type TextAnnotation = BaseAnnotation & {
  type: 'text'
  x: number
  y: number
  value: string
  color: string
}

type ArrowAnnotation = BaseAnnotation & {
  type: 'arrow'
  x1: number
  y1: number
  x2: number
  y2: number
  color: string
  style: ArrowStyle
  controlX?: number
  controlY?: number
}

type Annotation = RectAnnotation | StrikeAnnotation | TextAnnotation | ArrowAnnotation

type CropAspect = 'free' | '1:1' | '4:3' | '16:9'

type CropSelection = {
  x: number
  y: number
  width: number
  height: number
}

type OcrWord = {
  id: string
  text: string
  confidence: number
  x: number
  y: number
  width: number
  height: number
  sensitive: boolean
}

type QuickCommitFx = {
  id: string
  previewUrl: string
  imagePath: string
  notePath: string | null
  noteText: string
  clipboardState: 'copied' | 'skipped' | 'failed'
}

type SavedCaptureResult = {
  imagePath: string
  notePath: string | null
}

type MemoryStopSummary = {
  id: string
  dataDir: string
  frameCount: number
  segmentCount: number
  elapsedLabel: string
}

type GalleryThumb = {
  id: number
  timestamp: string
  imageDataUrl: string
}

type QuickToolbarMetrics = {
  width: number
  topHeight: number
  bottomHeight: number
}

type OcrSelectionResult = {
  pending: boolean
  text: string
}

type ReportStage = 'recording' | 'preview'

type ReportDebugTone = 'idle' | 'working' | 'ok' | 'warn' | 'error'

type ReportDebugState = {
  detail: string
  tone: ReportDebugTone
}

type SpeechRecognitionConstructor = new () => {
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((event: Event & { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null
  onerror: ((event: Event & { error?: string }) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
}

const TOOL_LABEL: Record<Tool, string> = {
  select: 'Select',
  crop: 'Crop',
  'ocr-select': 'OCR Select',
  arrow: 'Arrow',
  border: 'Border',
  blur: 'Blur',
  pixelate: 'Pixelate',
  blackout: 'Blackout',
  highlight: 'Highlight',
  strike: 'Strike',
  text: 'Text',
}

const BLUR_STRENGTH = 12
const DEFAULT_ACCENT_COLOR = '#ff2b2b'
const MIN_ZOOM = 0.35
const MAX_ZOOM = 2.6
const DEFAULT_STROKE_WIDTH = 3
const QUICK_WINDOW_MIN_WIDTH = 460
const QUICK_WINDOW_MIN_HEIGHT = 320
const QUICK_TOOLBAR_FALLBACK_WIDTH = 980
const MEMORY_CORNER_HUD_WIDTH = 336
const MEMORY_CORNER_HUD_HEIGHT = 96
const MEMORY_CORNER_HUD_SUMMARY_HEIGHT = 128
const MEMORY_CORNER_HUD_MARGIN = 18
const QUICK_AUTO_ZOOM_MIN_TRIGGER = 1.08
const QUICK_AUTO_ZOOM_MAX = 2.2
const QUICK_AUTO_ZOOM_TARGET_WIDTH_RATIO = 0.62
const QUICK_AUTO_ZOOM_TARGET_HEIGHT_RATIO = 0.58
const QUICK_ACCENT_SWATCHES = ['#ff2b2b', '#ff7a29', '#ffd049', '#17c67b', '#4ea8ff', '#f8fafc'] as const
const MEMORY_TIMELINE_WINDOW_HOURS = 6
const MEMORY_TIMELINE_LIMIT = 14
const NOTE_STORAGE_LABEL = 'Saved locally next to the PNG as a TXT note'
const CROP_ASPECT_RATIOS: Record<Exclude<CropAspect, 'free'>, number> = {
  '1:1': 1,
  '4:3': 4 / 3,
  '16:9': 16 / 9,
}
const ARROW_STYLE_LABEL: Record<ArrowStyle, string> = {
  classic: 'Arrow Classic',
  double: 'Arrow Double',
  line: 'Arrow Open',
  curved: 'Arrow Curved',
}
const ARROW_STYLE_OPTIONS: ArrowStyle[] = ['classic', 'double', 'line', 'curved']
const CROP_ASPECT_OPTIONS: CropAspect[] = ['free', '1:1', '4:3', '16:9']
const STROKE_WIDTH_OPTIONS = [2, 3, 5, 7] as const
const SNAP_DISTANCE = 14
const APP_VERSION_LABEL = `v${__APP_VERSION__}`
const CODE_SEVERITY_LABEL: Record<DetectedCode['severity'], string> = {
  critical: 'Critical',
  sensitive: 'Sensitive',
  benign: 'Info',
}
const CODE_PAYLOAD_PREVIEW_LIMIT = 140

const truncatePayload = (text: string): string =>
  text.length > CODE_PAYLOAD_PREVIEW_LIMIT
    ? `${text.slice(0, CODE_PAYLOAD_PREVIEW_LIMIT)}...`
    : text

const createId = (): string =>
  globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`

const normalizeRect = (start: Point, end: Point) => {
  const x = Math.min(start.x, end.x)
  const y = Math.min(start.y, end.y)
  const width = Math.abs(end.x - start.x)
  const height = Math.abs(end.y - start.y)

  return { x, y, width, height }
}

const bboxToRect = (bbox: Bbox) => ({
  x: bbox.x0,
  y: bbox.y0,
  width: Math.max(0, bbox.x1 - bbox.x0),
  height: Math.max(0, bbox.y1 - bbox.y0),
})

const isRectTool = (tool: Tool): tool is RectAnnotationType =>
  tool === 'blur' || tool === 'blackout' || tool === 'highlight' || tool === 'pixelate' || tool === 'border'

const collectWordsFromBlocks = (blocks: Block[] | null): Word[] => {
  if (!blocks) {
    return []
  }

  const words: Word[] = []

  for (const block of blocks) {
    for (const paragraph of block.paragraphs) {
      for (const line of paragraph.lines) {
        words.push(...line.words)
      }
    }
  }

  return words
}

const toDataUrl = async (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result)
        return
      }
      reject(new Error('Cannot read image data'))
    }
    reader.onerror = () => reject(reader.error ?? new Error('Cannot read image data'))
    reader.readAsDataURL(blob)
  })

const getLocalLangPath = (): string =>
  typeof window !== 'undefined' ? `${window.location.origin}/tessdata` : '/tessdata'

/**
 * Worker options that keep OCR entirely on this machine.
 *
 * tesseract.js defaults `workerPath` and `corePath` to cdn.jsdelivr.net, so
 * bundling only the language data still left every cold start reaching for the
 * network - and telling a CDN each time someone redacted a screenshot. The
 * files are vendored into public/tesseract by scripts/vendor-tesseract.mjs.
 *
 * corePath stays a directory so tesseract picks the right build for the CPU's
 * SIMD support at runtime.
 */
const getLocalWorkerOptions = () => {
  const origin = typeof window !== 'undefined' ? window.location.origin : ''

  return {
    langPath: getLocalLangPath(),
    workerPath: `${origin}/tesseract/worker.min.js`,
    corePath: `${origin}/tesseract/`,
    gzip: true,
  }
}

const isDesktopRuntime = (): boolean => {
  if (typeof window === 'undefined') {
    return false
  }

  try {
    return isTauri()
  } catch {
    return '__TAURI_INTERNALS__' in window
  }
}

const getInitialWindowLabel = (): string => {
  if (typeof window === 'undefined') {
    return 'browser'
  }

  const metadata = (window as Window & {
    __TAURI_INTERNALS__?: {
      metadata?: {
        currentWindow?: { label?: string }
        currentWebview?: { label?: string }
      }
    }
  }).__TAURI_INTERNALS__?.metadata

  return metadata?.currentWebview?.label ?? metadata?.currentWindow?.label ?? 'main'
}

const formatBlobSize = (size: number): string => {
  if (size < 1024) {
    return `${size} B`
  }

  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`
  }

  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

const formatMemoryTimestamp = (timestamp: string): string => {
  const parsed = new Date(timestamp)
  if (Number.isNaN(parsed.getTime())) {
    return timestamp
  }

  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(parsed)
}

const formatElapsedTimer = (totalSeconds: number): string => {
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60

  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

const summarizeMemoryText = (text: string, maxLength = 180): string => {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) {
    return 'No OCR text extracted for this frame yet.'
  }

  if (normalized.length <= maxLength) {
    return normalized
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`
}

const getMemoryTimelineWindow = (): { start: string; end: string } => {
  const end = new Date()
  const start = new Date(end.getTime() - MEMORY_TIMELINE_WINDOW_HOURS * 60 * 60 * 1000)

  return {
    start: start.toISOString(),
    end: end.toISOString(),
  }
}

const idleReportDebugState = (detail: string): ReportDebugState => ({
  detail,
  tone: 'idle',
})

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))

const getSuggestedQuickZoom = (image: HTMLImageElement | null, monitorScale: number): number => {
  if (!image) {
    return 1
  }

  const normalizedScale = monitorScale > 0 ? monitorScale : window.devicePixelRatio || 1
  const logicalWidth = image.naturalWidth / normalizedScale
  const logicalHeight = image.naturalHeight / normalizedScale

  if (!Number.isFinite(logicalWidth) || !Number.isFinite(logicalHeight) || logicalWidth <= 0 || logicalHeight <= 0) {
    return 1
  }

  const availableWidth = Math.max(360, window.innerWidth - 160)
  const availableHeight = Math.max(240, window.innerHeight - 240)
  const targetWidth = availableWidth * QUICK_AUTO_ZOOM_TARGET_WIDTH_RATIO
  const targetHeight = availableHeight * QUICK_AUTO_ZOOM_TARGET_HEIGHT_RATIO
  const suggestedZoom = Math.min(targetWidth / logicalWidth, targetHeight / logicalHeight)

  if (!Number.isFinite(suggestedZoom) || suggestedZoom < QUICK_AUTO_ZOOM_MIN_TRIGGER) {
    return 1
  }

  return clamp(suggestedZoom, 1, QUICK_AUTO_ZOOM_MAX)
}

const hexToRgba = (hex: string, alpha: number): string => {
  const normalized = hex.trim().replace('#', '')
  const expanded =
    normalized.length === 3
      ? normalized
          .split('')
          .map((part) => `${part}${part}`)
          .join('')
      : normalized

  if (!/^[A-Fa-f0-9]{6}$/.test(expanded)) {
    return `rgba(255, 43, 43, ${alpha})`
  }

  const red = Number.parseInt(expanded.slice(0, 2), 16)
  const green = Number.parseInt(expanded.slice(2, 4), 16)
  const blue = Number.parseInt(expanded.slice(4, 6), 16)
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`
}

const distancePointToSegment = (
  point: Point,
  segmentStart: Point,
  segmentEnd: Point,
): number => {
  const dx = segmentEnd.x - segmentStart.x
  const dy = segmentEnd.y - segmentStart.y

  if (dx === 0 && dy === 0) {
    return Math.hypot(point.x - segmentStart.x, point.y - segmentStart.y)
  }

  const ratio =
    ((point.x - segmentStart.x) * dx + (point.y - segmentStart.y) * dy) / (dx * dx + dy * dy)
  const t = clamp(ratio, 0, 1)

  const projectionX = segmentStart.x + t * dx
  const projectionY = segmentStart.y + t * dy

  return Math.hypot(point.x - projectionX, point.y - projectionY)
}

const sanitizeCropSelection = (
  crop: CropSelection,
  boundsWidth: number,
  boundsHeight: number,
): CropSelection | null => {
  const x = clamp(crop.x, 0, boundsWidth)
  const y = clamp(crop.y, 0, boundsHeight)
  const maxWidth = Math.max(1, boundsWidth - x)
  const maxHeight = Math.max(1, boundsHeight - y)
  const width = clamp(crop.width, 1, maxWidth)
  const height = clamp(crop.height, 1, maxHeight)

  if (width < 1 || height < 1) {
    return null
  }

  return {
    x,
    y,
    width,
    height,
  }
}

const randomUnitFromSeed = (seed: number): number => {
  const next = Math.sin(seed * 12.9898 + 78.233) * 43758.5453123
  return next - Math.floor(next)
}

const getArrowControlPoint = (start: Point, end: Point): Point => {
  const middleX = (start.x + end.x) / 2
  const middleY = (start.y + end.y) / 2
  const dx = end.x - start.x
  const dy = end.y - start.y
  const length = Math.max(1, Math.hypot(dx, dy))
  const offset = Math.min(140, length * 0.32)

  return {
    x: middleX - (dy / length) * offset,
    y: middleY + (dx / length) * offset,
  }
}

const applyAspectRatioToCrop = (
  start: Point,
  end: Point,
  aspect: CropAspect,
  imageWidth: number,
  imageHeight: number,
): Point => {
  if (aspect === 'free') {
    return {
      x: clamp(end.x, 0, imageWidth),
      y: clamp(end.y, 0, imageHeight),
    }
  }

  const ratio = CROP_ASPECT_RATIOS[aspect]
  const dx = end.x - start.x
  const dy = end.y - start.y
  const signX = dx >= 0 ? 1 : -1
  const signY = dy >= 0 ? 1 : -1

  let absX = Math.abs(dx)
  let absY = Math.abs(dy)
  if (absY === 0) {
    absY = 1
  }

  if (absX / absY > ratio) {
    absX = absY * ratio
  } else {
    absY = absX / ratio
  }

  return {
    x: clamp(start.x + absX * signX, 0, imageWidth),
    y: clamp(start.y + absY * signY, 0, imageHeight),
  }
}

const snapCropRectToEdges = (
  cropRect: CropSelection,
  imageWidth: number,
  imageHeight: number,
): CropSelection => {
  let x = cropRect.x
  let y = cropRect.y
  let width = cropRect.width
  let height = cropRect.height

  if (Math.abs(x) <= SNAP_DISTANCE) {
    width += x
    x = 0
  }

  if (Math.abs(y) <= SNAP_DISTANCE) {
    height += y
    y = 0
  }

  const right = x + width
  if (Math.abs(imageWidth - right) <= SNAP_DISTANCE) {
    width = imageWidth - x
  }

  const bottom = y + height
  if (Math.abs(imageHeight - bottom) <= SNAP_DISTANCE) {
    height = imageHeight - y
  }

  return {
    x: clamp(x, 0, imageWidth),
    y: clamp(y, 0, imageHeight),
    width: clamp(width, 1, imageWidth),
    height: clamp(height, 1, imageHeight),
  }
}

const distancePointToQuadratic = (
  point: Point,
  start: Point,
  control: Point,
  end: Point,
): number => {
  let minDistance = Number.POSITIVE_INFINITY
  let previousPoint = start
  const segments = 24

  for (let step = 1; step <= segments; step += 1) {
    const t = step / segments
    const oneMinus = 1 - t
    const currentPoint = {
      x: oneMinus * oneMinus * start.x + 2 * oneMinus * t * control.x + t * t * end.x,
      y: oneMinus * oneMinus * start.y + 2 * oneMinus * t * control.y + t * t * end.y,
    }

    minDistance = Math.min(minDistance, distancePointToSegment(point, previousPoint, currentPoint))
    previousPoint = currentPoint
  }

  return minDistance
}

const getAnnotationBounds = (
  annotation: Annotation,
): { x: number; y: number; width: number; height: number } => {
  if (annotation.type === 'arrow') {
    const control = annotation.style === 'curved'
      ? { x: annotation.controlX ?? (annotation.x1 + annotation.x2) / 2, y: annotation.controlY ?? (annotation.y1 + annotation.y2) / 2 }
      : null
    const valuesX = control ? [annotation.x1, annotation.x2, control.x] : [annotation.x1, annotation.x2]
    const valuesY = control ? [annotation.y1, annotation.y2, control.y] : [annotation.y1, annotation.y2]
    const minX = Math.min(...valuesX)
    const minY = Math.min(...valuesY)
    const maxX = Math.max(...valuesX)
    const maxY = Math.max(...valuesY)
    return {
      x: minX,
      y: minY,
      width: Math.max(1, maxX - minX),
      height: Math.max(1, maxY - minY),
    }
  }

  if (annotation.type === 'strike') {
    const minX = Math.min(annotation.x1, annotation.x2)
    const minY = Math.min(annotation.y1, annotation.y2)
    const maxX = Math.max(annotation.x1, annotation.x2)
    const maxY = Math.max(annotation.y1, annotation.y2)
    return {
      x: minX,
      y: minY,
      width: Math.max(1, maxX - minX),
      height: Math.max(1, maxY - minY),
    }
  }

  if (annotation.type === 'text') {
    const width = Math.max(92, annotation.value.length * 14)
    return {
      x: annotation.x,
      y: annotation.y,
      width,
      height: 36,
    }
  }

  return {
    x: annotation.x,
    y: annotation.y,
    width: annotation.width,
    height: annotation.height,
  }
}

const hitTestAnnotation = (point: Point, annotations: Annotation[]): Annotation | null => {
  for (let index = annotations.length - 1; index >= 0; index -= 1) {
    const annotation = annotations[index]

    if (annotation.type === 'arrow') {
      const tolerance = 12
      if (annotation.style === 'curved') {
        const control = {
          x: annotation.controlX ?? (annotation.x1 + annotation.x2) / 2,
          y: annotation.controlY ?? (annotation.y1 + annotation.y2) / 2,
        }

        if (
          distancePointToQuadratic(
            point,
            { x: annotation.x1, y: annotation.y1 },
            control,
            { x: annotation.x2, y: annotation.y2 },
          ) <= tolerance
        ) {
          return annotation
        }
      } else if (
        distancePointToSegment(
          point,
          { x: annotation.x1, y: annotation.y1 },
          { x: annotation.x2, y: annotation.y2 },
        ) <= tolerance
      ) {
        return annotation
      }

      continue
    }

    if (annotation.type === 'strike') {
      const distance = distancePointToSegment(
        point,
        { x: annotation.x1, y: annotation.y1 },
        { x: annotation.x2, y: annotation.y2 },
      )

      if (distance <= 12) {
        return annotation
      }

      continue
    }

    const bounds = getAnnotationBounds(annotation)
    const insideX = point.x >= bounds.x && point.x <= bounds.x + bounds.width
    const insideY = point.y >= bounds.y && point.y <= bounds.y + bounds.height

    if (insideX && insideY) {
      return annotation
    }
  }

  return null
}

const moveAnnotationBy = (annotation: Annotation, deltaX: number, deltaY: number): Annotation => {
  if (annotation.type === 'arrow') {
    return {
      ...annotation,
      x1: annotation.x1 + deltaX,
      y1: annotation.y1 + deltaY,
      x2: annotation.x2 + deltaX,
      y2: annotation.y2 + deltaY,
      controlX: typeof annotation.controlX === 'number' ? annotation.controlX + deltaX : undefined,
      controlY: typeof annotation.controlY === 'number' ? annotation.controlY + deltaY : undefined,
    }
  }

  if (annotation.type === 'strike') {
    return {
      ...annotation,
      x1: annotation.x1 + deltaX,
      y1: annotation.y1 + deltaY,
      x2: annotation.x2 + deltaX,
      y2: annotation.y2 + deltaY,
    }
  }

  if (annotation.type === 'text') {
    return {
      ...annotation,
      x: annotation.x + deltaX,
      y: annotation.y + deltaY,
    }
  }

  return {
    ...annotation,
    x: annotation.x + deltaX,
    y: annotation.y + deltaY,
  }
}

const drawArrowHead = (
  ctx: CanvasRenderingContext2D,
  from: Point,
  to: Point,
  color: string,
  filled: boolean,
) => {
  const angle = Math.atan2(to.y - from.y, to.x - from.x)
  const headLength = 15
  const headWidth = 0.62
  const left = {
    x: to.x - headLength * Math.cos(angle - headWidth),
    y: to.y - headLength * Math.sin(angle - headWidth),
  }
  const right = {
    x: to.x - headLength * Math.cos(angle + headWidth),
    y: to.y - headLength * Math.sin(angle + headWidth),
  }

  ctx.save()
  ctx.beginPath()
  ctx.moveTo(to.x, to.y)
  ctx.lineTo(left.x, left.y)
  ctx.lineTo(right.x, right.y)
  ctx.closePath()
  if (filled) {
    ctx.fillStyle = color
    ctx.fill()
  } else {
    ctx.strokeStyle = color
    ctx.lineWidth = 3
    ctx.stroke()
  }
  ctx.restore()
}

function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const textToolInputRef = useRef<HTMLInputElement | null>(null)
  const quickEditorToolbarRef = useRef<HTMLDivElement | null>(null)
  const quickToolbarRef = useRef<HTMLDivElement | null>(null)
  const reportComposerRef = useRef<HTMLDivElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const drawingStartRef = useRef<Point | null>(null)
  const drawingRef = useRef(false)
  const selectionDragRef = useRef<{ id: string; lastPoint: Point } | null>(null)
  const quickWindowPositionedSessionRef = useRef<number | null>(null)
  const quickToolbarLayoutSignatureRef = useRef('')
  const quickEditorOpenedAtRef = useRef(0)
  const quickBlurGuardUntilRef = useRef(0)
  const imageLoadRequestIdRef = useRef(0)
  const memoryCountdownStartedAtRef = useRef<number | null>(null)
  const reportRecorderRef = useRef<MediaRecorder | null>(null)
  const reportStreamRef = useRef<MediaStream | null>(null)
  const reportAudioChunksRef = useRef<Blob[]>([])
  const reportAudioBlobRef = useRef<Blob | null>(null)
  const reportStopResolverRef = useRef<((blob: Blob | null) => void) | null>(null)
  const reportRecognitionRef = useRef<InstanceType<SpeechRecognitionConstructor> | null>(null)

  const [currentWindowLabel, setCurrentWindowLabel] = useState(getInitialWindowLabel)
  const [imageSource, setImageSource] = useState<string | null>(null)
  const [baseImage, setBaseImage] = useState<HTMLImageElement | null>(null)
  const [activeTool, setActiveTool] = useState<Tool>('select')
  const [annotations, setAnnotations] = useState<Annotation[]>([])
  const [draftAnnotation, setDraftAnnotation] = useState<Annotation | null>(null)
  const [cropRect, setCropRect] = useState<CropSelection | null>(null)
  const [draftCropRect, setDraftCropRect] = useState<CropSelection | null>(null)
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null)
  const [accentColor, setAccentColor] = useState(DEFAULT_ACCENT_COLOR)
  const [strokeWidth, setStrokeWidth] = useState(DEFAULT_STROKE_WIDTH)
  const [arrowStyle, setArrowStyle] = useState<ArrowStyle>('classic')
  const [cropAspect, setCropAspect] = useState<CropAspect>('free')
  const [zoomLevel, setZoomLevel] = useState(1)
  const [quickEditorOpen, setQuickEditorOpen] = useState(false)
  const [quickSessionId, setQuickSessionId] = useState(0)
  const [quickCaptureCursor, setQuickCaptureCursor] = useState<DesktopCursorPoint | null>(null)
  const [quickMonitorScale, setQuickMonitorScale] = useState(() => window.devicePixelRatio || 1)
  const [quickCommitFx, setQuickCommitFx] = useState<QuickCommitFx | null>(null)
  const [, setQuickToolbarMetrics] = useState<QuickToolbarMetrics>({
    width: QUICK_TOOLBAR_FALLBACK_WIDTH,
    topHeight: 44,
    bottomHeight: 44,
  })
  const [showCrosshair, setShowCrosshair] = useState(false)
  const [textPromptPosition, setTextPromptPosition] = useState<Point | null>(null)
  const [textPromptValue, setTextPromptValue] = useState('')
  const [isSavingAnimation, setIsSavingAnimation] = useState(false)

  const [ocrWords, setOcrWords] = useState<OcrWord[]>([])
  const [, setOcrText] = useState('')
  const [, setOcrProgress] = useState(0)
  const [, setOcrStatus] = useState('OCR idle')
  const [ocrRunning, setOcrRunning] = useState(false)
  const [, setOcrSelectionRunning] = useState(false)
  const [showOcrOverlay] = useState(true)
  const [autoOcrEnabled] = useState(true)
  const [autoOcrProcessedSource, setAutoOcrProcessedSource] = useState<string | null>(null)
  const [ocrSelectionResult, setOcrSelectionResult] = useState<OcrSelectionResult | null>(null)
  const [detectedCodes, setDetectedCodes] = useState<DetectedCode[]>([])
  const [codeScanRunning, setCodeScanRunning] = useState(false)
  const [codeScanError, setCodeScanError] = useState('')
  const [codeScanProcessedSource, setCodeScanProcessedSource] = useState<string | null>(null)
  // Critical payloads stay hidden until asked for, so a screenshot of VanillaShot
  // itself does not leak the very seed the user is trying to redact.
  const [revealedCodeIds, setRevealedCodeIds] = useState<string[]>([])

  const [copyStatus, setCopyStatus] = useState('')
  const [errorMessage, setErrorMessage] = useState('')
  const [pendingWindowReveal, setPendingWindowReveal] = useState(false)
  const [reportOpen, setReportOpen] = useState(false)
  const [reportDetailsOpen, setReportDetailsOpen] = useState(false)
  const [reportStage, setReportStage] = useState<ReportStage>('recording')
  const [reportDraft, setReportDraft] = useState('')
  const [reportCommittedText, setReportCommittedText] = useState('')
  const [reportAudioBlob, setReportAudioBlob] = useState<Blob | null>(null)
  const [reportRecording, setReportRecording] = useState(false)
  const [reportSubmitting, setReportSubmitting] = useState(false)
  const [reportStatus, setReportStatus] = useState('Ready to add note')
  const [reportSpeechState, setReportSpeechState] = useState<ReportDebugState>(() => idleReportDebugState('Idle'))
  const [reportMicState, setReportMicState] = useState<ReportDebugState>(() => idleReportDebugState('Idle'))
  const [reportPayloadState, setReportPayloadState] = useState<ReportDebugState>(() => idleReportDebugState('Waiting for note text'))
  const [reportApiState, setReportApiState] = useState<ReportDebugState>(() =>
    idleReportDebugState(`Ready: ${NOTE_STORAGE_LABEL}`),
  )
  const [memoryStatus, setMemoryStatus] = useState<MemoryStatus | null>(null)
  const [, setMemoryStatusLoading] = useState(false)
  const [memoryActionLoading, setMemoryActionLoading] = useState(false)
  const [, setMemoryTimelineLoading] = useState(false)
  const [memoryTimelineFrames, setMemoryTimelineFrames] = useState<MemoryFrame[]>([])
  const [screenRecordingGranted, setScreenRecordingGranted] = useState<boolean | null>(null)
  const [captureDir, setCaptureDir] = useState<string | null>(null)
  const [memoryNotice, setMemoryNotice] = useState<{ tone: 'ok' | 'error'; detail: string } | null>(null)
  const [memoryCountdownValue, setMemoryCountdownValue] = useState<number | null>(null)
  const [memoryRecordingElapsedSecs, setMemoryRecordingElapsedSecs] = useState(0)
  const [memoryStopSummary, setMemoryStopSummary] = useState<MemoryStopSummary | null>(null)
  const [memoryCornerHudOpen, setMemoryCornerHudOpen] = useState(false)
  const [galleryThumbs, setGalleryThumbs] = useState<GalleryThumb[]>([])
  const isDedicatedQuickWindow = currentWindowLabel === QUICK_EDITOR_WINDOW_LABEL

  const resetReportDebugState = useCallback(() => {
    setReportSpeechState(idleReportDebugState('Idle'))
    setReportMicState(idleReportDebugState('Idle'))
    setReportPayloadState(idleReportDebugState('Waiting for note text'))
    setReportApiState(idleReportDebugState(`Ready: ${NOTE_STORAGE_LABEL}`))
  }, [])

  const clearImageState = useCallback(() => {
    setAnnotations([])
    setDraftAnnotation(null)
    setCropRect(null)
    setDraftCropRect(null)
    setSelectedAnnotationId(null)
    selectionDragRef.current = null
    setOcrWords([])
    setOcrText('')
    setOcrStatus('OCR idle')
    setOcrProgress(0)
    setZoomLevel(1)
    setShowCrosshair(false)
    setTextPromptPosition(null)
    setTextPromptValue('')
    setOcrSelectionResult(null)
    setQuickMonitorScale(window.devicePixelRatio || 1)
    setReportOpen(false)
    setReportDetailsOpen(false)
    setReportStage('recording')
    setReportDraft('')
    setReportCommittedText('')
    setReportAudioBlob(null)
    reportAudioBlobRef.current = null
    setReportRecording(false)
    setReportSubmitting(false)
    setReportStatus('Ready to add note')
    resetReportDebugState()
  }, [resetReportDebugState])

  const closeCurrentDesktopWindow = useCallback(async () => {
    if (!isDesktopRuntime()) {
      return
    }

    try {
      const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow')
      await getCurrentWebviewWindow().close()
    } catch {
      // Ignore restricted desktop environments.
    }
  }, [])

  const collapseQuickEditorToMemoryHud = useCallback(() => {
    drawingRef.current = false
    selectionDragRef.current = null
    setDraftAnnotation(null)
    setDraftCropRect(null)
    setSelectedAnnotationId(null)
    setCropRect(null)
    setTextPromptPosition(null)
    setTextPromptValue('')
    setOcrSelectionResult(null)
    setReportOpen(false)
    setReportDetailsOpen(false)
    setMemoryCornerHudOpen(true)
    setQuickEditorOpen(false)
  }, [])

  const dismissQuickEditor = useCallback(() => {
    if (memoryStatus?.recording || memoryStopSummary) {
      collapseQuickEditorToMemoryHud()
      return
    }

    setQuickCaptureCursor(null)
    setTextPromptPosition(null)
    setTextPromptValue('')
    setOcrSelectionResult(null)
    setQuickEditorOpen(false)
    setMemoryCornerHudOpen(false)

    if (isDedicatedQuickWindow) {
      void closeCurrentDesktopWindow()
    }
  }, [
    closeCurrentDesktopWindow,
    collapseQuickEditorToMemoryHud,
    isDedicatedQuickWindow,
    memoryStatus?.recording,
    memoryStopSummary,
  ])

  useEffect(() => {
    if (!isDesktopRuntime()) {
      return
    }

    if (isDedicatedQuickWindow) {
      return
    }

    let cancelled = false

    const syncCurrentWindowLabel = async () => {
      try {
        const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow')
        if (!cancelled) {
          setCurrentWindowLabel(getCurrentWebviewWindow().label)
        }
      } catch {
        // Ignore restricted desktop environments.
      }
    }

    void syncCurrentWindowLabel()

    return () => {
      cancelled = true
    }
  }, [isDedicatedQuickWindow])

  const loadImageFromDataUrl = useCallback(
    async (
      dataUrl: string,
      options?: {
        openQuickEditor?: boolean
        cursor?: DesktopCursorPoint | null
        preserveWindowPlacement?: boolean
      },
    ) => {
      const requestId = imageLoadRequestIdRef.current + 1
      imageLoadRequestIdRef.current = requestId

      const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const nextImage = new Image()
        nextImage.onload = () => resolve(nextImage)
        nextImage.onerror = () => reject(new Error('Could not decode image'))
        nextImage.src = dataUrl
      })

      if (imageLoadRequestIdRef.current !== requestId) {
        return
      }

      reportRecognitionRef.current?.stop()
      reportRecognitionRef.current = null
      if (reportRecorderRef.current && reportRecorderRef.current.state !== 'inactive') {
        reportRecorderRef.current.stop()
      }
      reportRecorderRef.current = null
      reportStreamRef.current?.getTracks().forEach((track) => track.stop())
      reportStreamRef.current = null
      reportAudioChunksRef.current = []
      reportStopResolverRef.current?.(null)
      reportStopResolverRef.current = null
      clearImageState()
      setAutoOcrProcessedSource(null)
      setBaseImage(image)
      setImageSource(dataUrl)
      setZoomLevel(options?.openQuickEditor ? getSuggestedQuickZoom(image, window.devicePixelRatio || 1) : 1)

      if (options?.openQuickEditor) {
        const preserveWindowPlacement = Boolean(options.preserveWindowPlacement && quickEditorOpen)
        if (preserveWindowPlacement) {
          quickBlurGuardUntilRef.current = Math.max(quickBlurGuardUntilRef.current, Date.now() + 1400)
        } else {
          quickEditorOpenedAtRef.current = Date.now()
          quickBlurGuardUntilRef.current = quickEditorOpenedAtRef.current + 2200
          setQuickSessionId((value) => value + 1)
        }

        setMemoryCornerHudOpen(false)
        setQuickEditorOpen(true)
        setQuickCaptureCursor(options.cursor ?? null)
        setActiveTool('select')
        return
      }

      setQuickCaptureCursor(options?.cursor ?? null)
      setQuickEditorOpen(false)
    },
    [clearImageState, quickEditorOpen],
  )

  const loadImageFromBlob = useCallback(
    async (
      blob: Blob,
      options?: {
        openQuickEditor?: boolean
        cursor?: DesktopCursorPoint | null
      },
    ) => {
      const dataUrl = await toDataUrl(blob)
      await loadImageFromDataUrl(dataUrl, options)
    },
    [loadImageFromDataUrl],
  )

  const handleOpenFilePicker = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  const refreshMemoryStatus = useCallback(async () => {
    if (!isDesktopRuntime()) {
      return
    }

    setMemoryStatusLoading(true)

    try {
      const status = await getMemoryStatus()
      setMemoryStatus(status)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not read memory status'
      setMemoryNotice({
        tone: 'error',
        detail: message,
      })
    } finally {
      setMemoryStatusLoading(false)
    }
  }, [])

  const handleOpenMemoryStopFolder = useCallback(async () => {
    if (!isDesktopRuntime() || !memoryStopSummary) {
      return
    }

    try {
      await openMemoryPathInFinder(memoryStopSummary.dataDir)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not open Finder'
      setMemoryNotice({
        tone: 'error',
        detail: message,
      })
    }
  }, [memoryStopSummary])

  const refreshEnvironmentInfo = useCallback(async () => {
    if (!isDesktopRuntime()) {
      return
    }

    try {
      const [granted, dir] = await Promise.all([
        invoke<boolean>('screen_recording_access_granted'),
        invoke<string>('capture_output_dir'),
      ])
      setScreenRecordingGranted(granted)
      setCaptureDir(dir)
    } catch {
      // Leaving the state null renders the status as unknown rather than lying.
      setScreenRecordingGranted(null)
    }
  }, [])

  const handleRevealPath = useCallback(async (path: string) => {
    if (!isDesktopRuntime() || !path) {
      return
    }

    try {
      await openMemoryPathInFinder(path)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not open Finder'
      setMemoryNotice({ tone: 'error', detail: message })
    }
  }, [])

  const handleOpenProjectPage = useCallback(async () => {
    try {
      await invoke('open_project_page')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not open the project page'
      setMemoryNotice({ tone: 'error', detail: message })
    }
  }, [])

  const handleOpenRecordingSettings = useCallback(async () => {
    if (!isDesktopRuntime()) {
      return
    }

    try {
      await invoke('open_screen_recording_settings')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not open System Settings'
      setMemoryNotice({ tone: 'error', detail: message })
    }
  }, [])

  const refreshMemoryTimeline = useCallback(async () => {
    if (!isDesktopRuntime()) {
      return
    }

    const { start, end } = getMemoryTimelineWindow()
    setMemoryTimelineLoading(true)

    try {
      const frames = await getMemoryTimeline(start, end, MEMORY_TIMELINE_LIMIT)
      setMemoryTimelineFrames(frames)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not load recent memory timeline'

      if (message.toLowerCase().includes('start recording first')) {
        setMemoryTimelineFrames([])
      } else {
        setMemoryNotice({
          tone: 'error',
          detail: message,
        })
      }
    } finally {
      setMemoryTimelineLoading(false)
    }
  }, [])

  const handleToggleMemoryRecording = useCallback(async () => {
    if (!isDesktopRuntime()) {
      return
    }

    setMemoryActionLoading(true)
    setMemoryNotice(null)

    try {
      if (memoryStatus?.recording) {
        const elapsedLabel = formatElapsedTimer(memoryRecordingElapsedSecs)
        await stopMemoryRecording()
        const freshStatus = await getMemoryStatus()
        setMemoryStatus(freshStatus)
        const summary: MemoryStopSummary = {
          id: String(Date.now()),
          dataDir: freshStatus.dataDir,
          frameCount: freshStatus.stats?.frameCount ?? 0,
          segmentCount: freshStatus.stats?.segmentCount ?? 0,
          elapsedLabel,
        }
        setMemoryStopSummary(summary)
        setMemoryNotice({
          tone: 'ok',
          detail: `Recording stopped (${elapsedLabel}). Saved to ${freshStatus.dataDir}`,
        })
      } else {
        setMemoryStopSummary(null)
        await startMemoryRecording()
        setMemoryNotice({
          tone: 'ok',
          detail: 'Memory recording started. New frames will appear here as OCR lands.',
        })
      }

      await refreshMemoryStatus()
      await refreshMemoryTimeline()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not toggle memory recording'
      setMemoryNotice({
        tone: 'error',
        detail: message,
      })
    } finally {
      setMemoryActionLoading(false)
    }
  }, [memoryRecordingElapsedSecs, memoryStatus?.recording, refreshMemoryStatus, refreshMemoryTimeline])

  const startMemoryRecordingFromQuickBar = useCallback(async () => {
    if (!isDesktopRuntime()) {
      return
    }

    setMemoryActionLoading(true)
    setMemoryNotice(null)

    try {
      await startMemoryRecording()
      collapseQuickEditorToMemoryHud()
      setMemoryNotice({
        tone: 'ok',
        detail: 'Memory recording is live. Stop here or from the menu bar when you are done.',
      })
      await refreshMemoryStatus()
      await refreshMemoryTimeline()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not start memory recording'
      setMemoryNotice({
        tone: 'error',
        detail: message,
      })
    } finally {
      setMemoryActionLoading(false)
    }
  }, [collapseQuickEditorToMemoryHud, refreshMemoryStatus, refreshMemoryTimeline])

  const handleQuickMemoryToggle = useCallback(async () => {
    if (!isDesktopRuntime()) {
      return
    }

    if (memoryStatus?.recording) {
      await handleToggleMemoryRecording()
      return
    }

    if (memoryCountdownValue !== null || memoryActionLoading) {
      return
    }

    if (!quickEditorOpen && memoryCornerHudOpen) {
      await startMemoryRecordingFromQuickBar()
      return
    }

    quickBlurGuardUntilRef.current = Date.now() + 5000
    memoryCountdownStartedAtRef.current = Date.now()
    setMemoryNotice(null)
    setMemoryCountdownValue(3)
  }, [
    handleToggleMemoryRecording,
    memoryActionLoading,
    memoryCountdownValue,
    memoryCornerHudOpen,
    memoryStatus?.recording,
    quickEditorOpen,
    startMemoryRecordingFromQuickBar,
  ])

  useEffect(() => {
    if (!isDesktopRuntime()) {
      return
    }

    let cancelled = false

    const bootstrapQuickCapture = async () => {
      try {
        const pendingCapture = await takePendingQuickCapture()
        if (!pendingCapture || cancelled) {
          return
        }

        setCurrentWindowLabel(QUICK_EDITOR_WINDOW_LABEL)
        setErrorMessage('')
        await loadImageFromDataUrl(pendingCapture.dataUrl, {
          openQuickEditor: true,
          cursor: pendingCapture.cursor ?? null,
        })
      } catch (error) {
        if (cancelled) {
          return
        }

        const message = error instanceof Error ? error.message : 'Could not load pending quick capture'
        setErrorMessage(message)
      }
    }

    void bootstrapQuickCapture()

    return () => {
      cancelled = true
    }
  }, [loadImageFromDataUrl])

  const handleFileSelect = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0]
      if (!file) {
        return
      }

      try {
        setErrorMessage('')
        await loadImageFromBlob(file, { openQuickEditor: true })
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not load selected image'
        setErrorMessage(message)
      } finally {
        event.target.value = ''
      }
    },
    [loadImageFromBlob],
  )

  const handleCaptureScreen = useCallback(async () => {
    try {
      setErrorMessage('')
      const result = await captureRegion()

      if (isDesktopRuntime() && !isDedicatedQuickWindow) {
        await openQuickCaptureWindow(result)
        return
      }

      setPendingWindowReveal(true)
      await loadImageFromDataUrl(result.dataUrl, {
        openQuickEditor: true,
        cursor: result.cursor ?? null,
        preserveWindowPlacement: isDedicatedQuickWindow,
      })
    } catch (error) {
      if (error instanceof CaptureError && error.code === 'CaptureCancelled') {
        return
      }

      const message = error instanceof Error ? error.message : 'Screen capture failed'
      setErrorMessage(message)
    }
  }, [isDedicatedQuickWindow, loadImageFromDataUrl])

  useEffect(() => {
    const onPaste = async (event: ClipboardEvent) => {
      const imageItem = event.clipboardData?.items
        ? Array.from(event.clipboardData.items).find((item) => item.type.startsWith('image/'))
        : null

      const blob = imageItem?.getAsFile()
      if (!blob) {
        return
      }

      event.preventDefault()

      try {
        setErrorMessage('')
        await loadImageFromBlob(blob, { openQuickEditor: true })
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not load pasted image'
        setErrorMessage(message)
      }
    }

    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [loadImageFromBlob])

  useEffect(() => {
    let cleanup: (() => void) | null = null
    let active = true

    const bindDesktopCaptureListener = async () => {
      if (isDedicatedQuickWindow) {
        cleanup = await listenForQuickEditorCapture((result) => {
          if (!active) {
            return
          }

          setErrorMessage('')
          void loadImageFromDataUrl(result.dataUrl, {
            openQuickEditor: true,
            cursor: result.cursor ?? null,
            preserveWindowPlacement: true,
          }).catch((error) => {
            const message = error instanceof Error ? error.message : 'Could not refresh quick editor'
            setErrorMessage(message)
          })
        })
        return
      }

      cleanup = await listenForDesktopCapture(
        (result) => {
          if (!active) {
            return
          }

          setErrorMessage('')
          void openQuickCaptureWindow(result).catch((error) => {
            const message = error instanceof Error ? error.message : 'Could not open quick editor'
            setErrorMessage(message)
          })
        },
        (error) => {
          if (!active || error.code === 'CaptureCancelled') {
            return
          }

          setErrorMessage(error.message)
        },
      )
    }

    void bindDesktopCaptureListener()

    return () => {
      active = false
      cleanup?.()
    }
  }, [isDedicatedQuickWindow, loadImageFromDataUrl])

  useEffect(() => {
    if (isDedicatedQuickWindow) {
      return
    }

    if (!pendingWindowReveal || !quickEditorOpen || !baseImage) {
      return
    }

    // The settings window is reached deliberately, from the tray. Capturing a
    // screenshot no longer drags it on screen behind the quick editor.
    setPendingWindowReveal(false)
  }, [baseImage, isDedicatedQuickWindow, pendingWindowReveal, quickEditorOpen])

  useEffect(() => {
    document.documentElement.classList.toggle('quick-editor-open', quickEditorOpen)
    document.body.classList.toggle('quick-editor-open', quickEditorOpen)
    return () => {
      document.documentElement.classList.remove('quick-editor-open')
      document.body.classList.remove('quick-editor-open')
    }
  }, [quickEditorOpen])

  useEffect(() => {
    if (!isDesktopRuntime()) {
      return
    }

    let cancelled = false

    const syncWindowTitle = async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window')
        if (cancelled) {
          return
        }

        await getCurrentWindow().setTitle('VanillaShot Settings')
      } catch {
        // Ignore web runtime and restricted desktop environments.
      }
    }

    void syncWindowTitle()

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (isDedicatedQuickWindow || quickEditorOpen || !isDesktopRuntime()) {
      return
    }

    void refreshMemoryStatus()
    void refreshMemoryTimeline()
    void refreshEnvironmentInfo()

    // Granting Screen Recording happens in System Settings, so the answer can
    // change while this window sits in the background. Re-ask on focus.
    const onFocus = () => void refreshEnvironmentInfo()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [isDedicatedQuickWindow, quickEditorOpen, refreshEnvironmentInfo, refreshMemoryStatus, refreshMemoryTimeline])

  useEffect(() => {
    if (isDedicatedQuickWindow || quickEditorOpen || !isDesktopRuntime()) {
      return
    }

    const intervalId = window.setInterval(() => {
      void refreshMemoryStatus()
      if (memoryStatus?.recording) {
        void refreshMemoryTimeline()
      }
    }, memoryStatus?.recording ? 12000 : 30000)

    return () => window.clearInterval(intervalId)
  }, [isDedicatedQuickWindow, memoryStatus?.recording, quickEditorOpen, refreshMemoryStatus, refreshMemoryTimeline])

  useEffect(() => {
    if (!quickEditorOpen || !isDesktopRuntime()) {
      return
    }

    void refreshMemoryStatus()
    void refreshMemoryTimeline()

    const intervalId = window.setInterval(() => {
      void refreshMemoryStatus()
      void refreshMemoryTimeline()
    }, memoryStatus?.recording ? 5000 : 15000)

    return () => window.clearInterval(intervalId)
  }, [memoryStatus?.recording, quickEditorOpen, refreshMemoryStatus, refreshMemoryTimeline])

  useEffect(() => {
    if (!memoryStatus?.recording || !memoryStatus.recordingStartedAt) {
      setMemoryRecordingElapsedSecs(0)
      return
    }

    const updateElapsed = () => {
      const startedAtMs = new Date(memoryStatus.recordingStartedAt ?? '').getTime()
      if (Number.isNaN(startedAtMs)) {
        setMemoryRecordingElapsedSecs(0)
        return
      }

      setMemoryRecordingElapsedSecs(Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000)))
    }

    updateElapsed()
    const intervalId = window.setInterval(updateElapsed, 1000)

    return () => window.clearInterval(intervalId)
  }, [memoryStatus?.recording, memoryStatus?.recordingStartedAt])

  useEffect(() => {
    if (memoryCountdownValue === null) {
      return
    }

    if (memoryStatus?.recording) {
      setMemoryCountdownValue(null)
      memoryCountdownStartedAtRef.current = null
      return
    }

    const timeoutId = window.setTimeout(() => {
      if (memoryCountdownValue > 1) {
        setMemoryCountdownValue((value) => (value && value > 1 ? value - 1 : null))
        return
      }

      setMemoryCountdownValue(null)
      memoryCountdownStartedAtRef.current = null
      void startMemoryRecordingFromQuickBar()
    }, 1000)

    return () => window.clearTimeout(timeoutId)
  }, [memoryCountdownValue, memoryStatus?.recording, startMemoryRecordingFromQuickBar])

  useEffect(() => {
    if (!quickCommitFx) {
      return
    }

    const timeoutId = window.setTimeout(() => {
      setQuickCommitFx(null)
    }, 2000)

    return () => window.clearTimeout(timeoutId)
  }, [quickCommitFx])

  // Auto-dismiss memory stop summary after 5 seconds
  useEffect(() => {
    if (!memoryStopSummary) {
      return
    }

    const timeoutId = window.setTimeout(() => {
      setMemoryStopSummary(null)
      if (!memoryStatus?.recording) {
        setMemoryCornerHudOpen(false)
      }
    }, 5000)

    return () => window.clearTimeout(timeoutId)
  }, [memoryStatus?.recording, memoryStopSummary])

  // Load gallery thumbnails from recent timeline frames
  useEffect(() => {
    if (!quickEditorOpen || memoryTimelineFrames.length === 0) {
      setGalleryThumbs([])
      return
    }

    let cancelled = false
    const loadThumbs = async () => {
      const recent = memoryTimelineFrames.slice(0, 8)
      const loaded: GalleryThumb[] = []
      for (const frame of recent) {
        if (cancelled) break
        try {
          const full = await getMemoryFrame(frame.id)
          if (full?.imageDataUrl) {
            loaded.push({ id: frame.id, timestamp: frame.timestamp, imageDataUrl: full.imageDataUrl })
          }
        } catch {
          // skip failed frames
        }
      }
      if (!cancelled) {
        setGalleryThumbs(loaded)
      }
    }

    void loadThumbs()
    return () => {
      cancelled = true
    }
  }, [quickEditorOpen, memoryTimelineFrames])

  useEffect(() => {
    if (!quickEditorOpen) {
      quickWindowPositionedSessionRef.current = null
    }
  }, [quickEditorOpen])

  useEffect(() => {
    if (!quickEditorOpen) {
      return
    }

    const cancelQuickOnBlur = () => {
      if (Date.now() - quickEditorOpenedAtRef.current < 1200) {
        return
      }

      if (Date.now() < quickBlurGuardUntilRef.current) {
        return
      }

      if (reportOpen || reportSubmitting) {
        return
      }

      drawingRef.current = false
      selectionDragRef.current = null
      setDraftAnnotation(null)
      setDraftCropRect(null)
      setSelectedAnnotationId(null)
      setCropRect(null)
      setTextPromptPosition(null)
      setTextPromptValue('')
      setOcrSelectionResult(null)
      dismissQuickEditor()
    }

    window.addEventListener('blur', cancelQuickOnBlur)
    return () => window.removeEventListener('blur', cancelQuickOnBlur)
  }, [dismissQuickEditor, quickEditorOpen, reportOpen, reportSubmitting])

  useEffect(() => {
    if (!quickEditorOpen) {
      return
    }

    quickWindowPositionedSessionRef.current = null
    quickToolbarLayoutSignatureRef.current = ''
  }, [quickEditorOpen, quickSessionId])

  useEffect(() => {
    if (!quickEditorOpen || !baseImage) {
      return
    }

    const topToolbar = quickEditorToolbarRef.current
    const bottomToolbar = quickToolbarRef.current
    if (!topToolbar || !bottomToolbar) {
      return
    }

    const syncMetrics = () => {
      const nextMetrics = {
        width: Math.max(
          topToolbar.scrollWidth,
          topToolbar.offsetWidth,
          bottomToolbar.scrollWidth,
          bottomToolbar.offsetWidth,
        ),
        topHeight: topToolbar.offsetHeight,
        bottomHeight: bottomToolbar.offsetHeight,
      }

      setQuickToolbarMetrics((current) => {
        if (
          current.width === nextMetrics.width &&
          current.topHeight === nextMetrics.topHeight &&
          current.bottomHeight === nextMetrics.bottomHeight
        ) {
          return current
        }

        return nextMetrics
      })
    }

    syncMetrics()

    if (typeof ResizeObserver === 'undefined') {
      return
    }

    const observer = new ResizeObserver(() => {
      syncMetrics()
    })
    observer.observe(topToolbar)
    observer.observe(bottomToolbar)

    return () => {
      observer.disconnect()
    }
  }, [baseImage, quickEditorOpen])

  useEffect(() => {
    if (!isDesktopRuntime()) {
      return
    }

    let cancelled = false

    const syncQuickWindowStyle = async () => {
      try {
        const [{ getCurrentWindow, availableMonitors, primaryMonitor }, { LogicalSize, LogicalPosition }] = await Promise.all([
          import('@tauri-apps/api/window'),
          import('@tauri-apps/api/dpi'),
        ])
        if (cancelled) {
          return
        }

        const appWindow = getCurrentWindow()
        const showCornerMemoryHud =
          isDedicatedQuickWindow &&
          memoryCornerHudOpen &&
          !quickEditorOpen &&
          (memoryActionLoading || Boolean(memoryStatus?.recording) || Boolean(memoryStopSummary))

        if (quickEditorOpen) {
          await appWindow.setAlwaysOnTop(true)
          await appWindow.setDecorations(false)
          await appWindow.setResizable(false)
          await appWindow.setShadow(false)
          await appWindow.setBackgroundColor([0, 0, 0, 0])

          if (!baseImage) {
            quickWindowPositionedSessionRef.current = null
            await appWindow.hide()
            return
          }

          const geometrySignature = [
            quickCaptureCursor ? `${Math.round(quickCaptureCursor.x)}:${Math.round(quickCaptureCursor.y)}` : 'no-cursor',
          ].join(':')
          const isInitialPlacementForSession = quickWindowPositionedSessionRef.current !== quickSessionId

          if (
            isInitialPlacementForSession ||
            quickToolbarLayoutSignatureRef.current !== geometrySignature
          ) {
            quickBlurGuardUntilRef.current = Math.max(quickBlurGuardUntilRef.current, Date.now() + 1800)
            const monitors = await availableMonitors()
            let anchorMonitor = await primaryMonitor()

            if (quickCaptureCursor) {
              // quickCaptureCursor is in Physical Pixels from Tauri.
              // We compare the cursor to the physical bounding box of each monitor.
              const found = monitors.find((m) => {
                const x = m.position.x
                const y = m.position.y
                const w = m.size.width
                const h = m.size.height
                
                return quickCaptureCursor.x >= x && quickCaptureCursor.x < x + w &&
                       quickCaptureCursor.y >= y && quickCaptureCursor.y < y + h
              })
              if (found) {
                anchorMonitor = found
              }
            }

            const fallbackMonitor = anchorMonitor

            const workArea = anchorMonitor?.workArea ?? fallbackMonitor?.workArea ?? null
            const monitorScale = anchorMonitor?.scaleFactor ?? fallbackMonitor?.scaleFactor ?? window.devicePixelRatio ?? 1
            setQuickMonitorScale(monitorScale)

            const workAreaPositionLogical = workArea?.position 
              ? { x: workArea.position.x / monitorScale, y: workArea.position.y / monitorScale }
              : { x: 0, y: 0 }
              
            const workAreaSizeLogical = workArea?.size
              ? { width: workArea.size.width / monitorScale, height: workArea.size.height / monitorScale }
              : { width: Math.floor(window.screen.availWidth), height: Math.floor(window.screen.availHeight) }

            const targetX = Math.round(workAreaPositionLogical.x)
            const targetY = Math.round(workAreaPositionLogical.y)
            const targetWidthLogical = Math.max(QUICK_WINDOW_MIN_WIDTH, Math.round(workAreaSizeLogical.width))
            const targetHeightLogical = Math.max(QUICK_WINDOW_MIN_HEIGHT, Math.round(workAreaSizeLogical.height))
            const frameSignature = `${geometrySignature}:${targetX}:${targetY}:${targetWidthLogical}:${targetHeightLogical}`

            if (!isInitialPlacementForSession && quickToolbarLayoutSignatureRef.current === frameSignature) {
              return
            }

            await appWindow.setPosition(new LogicalPosition(targetX, targetY))
            await appWindow.setSize(new LogicalSize(targetWidthLogical, targetHeightLogical))

            quickWindowPositionedSessionRef.current = quickSessionId
            quickToolbarLayoutSignatureRef.current = frameSignature
          }

          if (isInitialPlacementForSession) {
            await appWindow.show()
            await appWindow.unminimize()
            await appWindow.setFocus()
          }
          return
        }

        if (showCornerMemoryHud) {
          await appWindow.setAlwaysOnTop(true)
          await appWindow.setDecorations(false)
          await appWindow.setResizable(false)
          await appWindow.setShadow(false)
          await appWindow.setBackgroundColor([0, 0, 0, 0])

          const monitors = await availableMonitors()
          let anchorMonitor = await primaryMonitor()

          if (quickCaptureCursor) {
            const found = monitors.find((monitor) => {
              const x = monitor.position.x
              const y = monitor.position.y
              const width = monitor.size.width
              const height = monitor.size.height

              return (
                quickCaptureCursor.x >= x &&
                quickCaptureCursor.x < x + width &&
                quickCaptureCursor.y >= y &&
                quickCaptureCursor.y < y + height
              )
            })

            if (found) {
              anchorMonitor = found
            }
          }

          const fallbackMonitor = anchorMonitor
          const workArea = anchorMonitor?.workArea ?? fallbackMonitor?.workArea ?? null
          const monitorScale =
            anchorMonitor?.scaleFactor ?? fallbackMonitor?.scaleFactor ?? window.devicePixelRatio ?? 1
          const workAreaPositionLogical = workArea?.position
            ? { x: workArea.position.x / monitorScale, y: workArea.position.y / monitorScale }
            : { x: 0, y: 0 }
          const workAreaSizeLogical = workArea?.size
            ? { width: workArea.size.width / monitorScale, height: workArea.size.height / monitorScale }
            : { width: Math.floor(window.screen.availWidth), height: Math.floor(window.screen.availHeight) }

          const targetWidthLogical = Math.min(
            MEMORY_CORNER_HUD_WIDTH,
            Math.max(280, Math.round(workAreaSizeLogical.width - MEMORY_CORNER_HUD_MARGIN * 2)),
          )
          const targetHeightLogical = memoryStatus?.recording
            ? MEMORY_CORNER_HUD_HEIGHT
            : MEMORY_CORNER_HUD_SUMMARY_HEIGHT
          const targetX = Math.round(
            workAreaPositionLogical.x + workAreaSizeLogical.width - targetWidthLogical - MEMORY_CORNER_HUD_MARGIN,
          )
          const targetY = Math.round(workAreaPositionLogical.y + MEMORY_CORNER_HUD_MARGIN)
          const hudSignature = `memory-hud:${targetX}:${targetY}:${targetWidthLogical}:${targetHeightLogical}:${
            memoryStatus?.recording ? 'live' : 'summary'
          }`

          if (quickToolbarLayoutSignatureRef.current !== hudSignature) {
            await appWindow.setPosition(new LogicalPosition(targetX, targetY))
            await appWindow.setSize(new LogicalSize(targetWidthLogical, targetHeightLogical))
            quickToolbarLayoutSignatureRef.current = hudSignature
          }

          await appWindow.show()
          await appWindow.unminimize()
          return
        }

        if (isDedicatedQuickWindow && !baseImage) {
          return
        }

        await appWindow.setAlwaysOnTop(false)
        await appWindow.setDecorations(true)
        await appWindow.setResizable(true)
        await appWindow.setShadow(true)
        await appWindow.setBackgroundColor('#05080f')
        await appWindow.hide()
      } catch {
        // Keep web fallback and restricted desktop environments silent.
      }
    }

    void syncQuickWindowStyle()

    return () => {
      cancelled = true
    }
  }, [
    baseImage,
    isDedicatedQuickWindow,
    memoryActionLoading,
    memoryCornerHudOpen,
    memoryStatus?.recording,
    memoryStopSummary,
    quickCaptureCursor,
    quickEditorOpen,
    quickSessionId,
  ])

  const drawAnnotation = useCallback(
    (ctx: CanvasRenderingContext2D, annotation: Annotation) => {
      switch (annotation.type) {
        case 'blackout': {
          ctx.save()
          ctx.fillStyle = 'rgba(10, 10, 10, 0.98)'
          ctx.fillRect(annotation.x, annotation.y, annotation.width, annotation.height)
          ctx.restore()
          return
        }
        case 'highlight': {
          ctx.save()
          ctx.fillStyle = annotation.fillColor ?? hexToRgba(DEFAULT_ACCENT_COLOR, 0.24)
          ctx.strokeStyle = annotation.borderColor ?? DEFAULT_ACCENT_COLOR
          ctx.lineWidth = 1.6
          ctx.fillRect(annotation.x, annotation.y, annotation.width, annotation.height)
          ctx.strokeRect(annotation.x, annotation.y, annotation.width, annotation.height)
          ctx.restore()
          return
        }
        case 'border': {
          ctx.save()
          ctx.strokeStyle = annotation.borderColor ?? DEFAULT_ACCENT_COLOR
          ctx.lineWidth = Math.max(1.2, annotation.borderWidth ?? DEFAULT_STROKE_WIDTH)
          ctx.strokeRect(annotation.x, annotation.y, annotation.width, annotation.height)
          ctx.restore()
          return
        }
        case 'blur': {
          if (!baseImage) {
            return
          }

          const width = Math.max(1, Math.round(annotation.width))
          const height = Math.max(1, Math.round(annotation.height))
          if (width <= 1 || height <= 1) {
            return
          }

          const downscale = clamp(Math.max(6, Math.round(Math.max(width, height) / 20)), 6, 26)
          const sampleWidth = Math.max(1, Math.round(width / downscale))
          const sampleHeight = Math.max(1, Math.round(height / downscale))
          const blurCanvas = document.createElement('canvas')
          blurCanvas.width = sampleWidth
          blurCanvas.height = sampleHeight
          const blurCtx = blurCanvas.getContext('2d')
          if (!blurCtx) {
            return
          }

          blurCtx.imageSmoothingEnabled = true
          blurCtx.drawImage(
            baseImage,
            annotation.x,
            annotation.y,
            width,
            height,
            0,
            0,
            sampleWidth,
            sampleHeight,
          )

          ctx.save()
          ctx.imageSmoothingEnabled = true
          ctx.drawImage(
            blurCanvas,
            0,
            0,
            sampleWidth,
            sampleHeight,
            annotation.x,
            annotation.y,
            width,
            height,
          )
          ctx.filter = `blur(${Math.max(4, Math.round(BLUR_STRENGTH * 0.55))}px)`
          ctx.drawImage(
            blurCanvas,
            0,
            0,
            sampleWidth,
            sampleHeight,
            annotation.x,
            annotation.y,
            width,
            height,
          )
          ctx.filter = 'none'
          ctx.fillStyle = 'rgba(8, 12, 18, 0.08)'
          ctx.fillRect(annotation.x, annotation.y, width, height)
          ctx.restore()

          ctx.save()
          ctx.strokeStyle = 'rgba(35, 35, 35, 0.34)'
          ctx.lineWidth = 1.2
          ctx.strokeRect(annotation.x, annotation.y, width, height)
          ctx.restore()
          return
        }
        case 'pixelate': {
          if (!baseImage) {
            return
          }

          const cellSize = Math.max(8, Math.min(36, Math.round(annotation.cellSize ?? 14)))
          const sampleWidth = Math.max(1, Math.round(annotation.width / cellSize))
          const sampleHeight = Math.max(1, Math.round(annotation.height / cellSize))
          const pixelCanvas = document.createElement('canvas')
          pixelCanvas.width = sampleWidth
          pixelCanvas.height = sampleHeight
          const pixelCtx = pixelCanvas.getContext('2d')
          if (!pixelCtx) {
            return
          }

          pixelCtx.imageSmoothingEnabled = true
          pixelCtx.drawImage(
            baseImage,
            annotation.x,
            annotation.y,
            annotation.width,
            annotation.height,
            0,
            0,
            sampleWidth,
            sampleHeight,
          )

          const imageData = pixelCtx.getImageData(0, 0, sampleWidth, sampleHeight)
          const seedBase = annotation.randomSeed ?? Math.floor((annotation.x + annotation.y) * 997)
          for (let offset = 0; offset < imageData.data.length; offset += 4) {
            const blockIndex = offset / 4
            const jitter = Math.round((randomUnitFromSeed(seedBase + blockIndex * 37.17) - 0.5) * 54)
            imageData.data[offset] = clamp(imageData.data[offset] + jitter, 0, 255)
            imageData.data[offset + 1] = clamp(imageData.data[offset + 1] - jitter, 0, 255)
            imageData.data[offset + 2] = clamp(imageData.data[offset + 2] + Math.round(jitter * 0.46), 0, 255)
          }
          pixelCtx.putImageData(imageData, 0, 0)

          ctx.save()
          ctx.imageSmoothingEnabled = false
          ctx.drawImage(
            pixelCanvas,
            0,
            0,
            sampleWidth,
            sampleHeight,
            annotation.x,
            annotation.y,
            annotation.width,
            annotation.height,
          )
          ctx.restore()

          ctx.save()
          ctx.strokeStyle = 'rgba(18, 20, 26, 0.52)'
          ctx.lineWidth = 1
          ctx.strokeRect(annotation.x, annotation.y, annotation.width, annotation.height)
          ctx.restore()
          return
        }
        case 'arrow': {
          ctx.save()
          ctx.strokeStyle = annotation.color
          ctx.lineWidth = Math.max(2.6, strokeWidth + 0.9)
          ctx.lineCap = 'round'
          ctx.lineJoin = 'round'

          if (annotation.style === 'curved') {
            const control = {
              x: annotation.controlX ?? (annotation.x1 + annotation.x2) / 2,
              y: annotation.controlY ?? (annotation.y1 + annotation.y2) / 2,
            }

            ctx.beginPath()
            ctx.moveTo(annotation.x1, annotation.y1)
            ctx.quadraticCurveTo(control.x, control.y, annotation.x2, annotation.y2)
            ctx.stroke()
            ctx.restore()

            drawArrowHead(ctx, control, { x: annotation.x2, y: annotation.y2 }, annotation.color, true)
            return
          }

          if (annotation.style === 'line') {
            ctx.setLineDash([8, 6])
          }

          ctx.beginPath()
          ctx.moveTo(annotation.x1, annotation.y1)
          ctx.lineTo(annotation.x2, annotation.y2)
          ctx.stroke()
          ctx.restore()

          drawArrowHead(
            ctx,
            { x: annotation.x1, y: annotation.y1 },
            { x: annotation.x2, y: annotation.y2 },
            annotation.color,
            annotation.style !== 'line',
          )

          if (annotation.style === 'double') {
            drawArrowHead(
              ctx,
              { x: annotation.x2, y: annotation.y2 },
              { x: annotation.x1, y: annotation.y1 },
              annotation.color,
              true,
            )
          }
          return
        }
        case 'strike': {
          ctx.save()
          ctx.strokeStyle = annotation.color
          ctx.lineWidth = Math.max(2.2, strokeWidth + 1.4)
          ctx.lineCap = 'round'
          ctx.beginPath()
          ctx.moveTo(annotation.x1, annotation.y1)
          ctx.lineTo(annotation.x2, annotation.y2)
          ctx.stroke()
          ctx.restore()
          return
        }
        case 'text': {
          ctx.save()
          ctx.font = '600 28px "Space Grotesk", "IBM Plex Sans", sans-serif'
          ctx.fillStyle = annotation.color
          ctx.textBaseline = 'top'
          ctx.fillText(annotation.value, annotation.x, annotation.y)
          ctx.restore()
          return
        }
        default: {
          return
        }
      }
    },
    [baseImage, strokeWidth],
  )

  const drawSelectionOutline = useCallback((ctx: CanvasRenderingContext2D, annotation: Annotation) => {
    const bounds = getAnnotationBounds(annotation)
    const padding = 6

    ctx.save()
    ctx.setLineDash([7, 5])
    ctx.lineWidth = 1.5
    ctx.strokeStyle = '#7cd5ff'
    ctx.strokeRect(
      bounds.x - padding,
      bounds.y - padding,
      bounds.width + padding * 2,
      bounds.height + padding * 2,
    )
    ctx.restore()
  }, [])

  const drawCropOverlay = useCallback((ctx: CanvasRenderingContext2D, crop: CropSelection) => {
    ctx.save()
    ctx.fillStyle = 'rgba(4, 6, 10, 0.54)'
    ctx.beginPath()
    ctx.rect(0, 0, ctx.canvas.width, ctx.canvas.height)
    ctx.rect(crop.x, crop.y, crop.width, crop.height)
    ctx.fill('evenodd')
    ctx.restore()

    ctx.save()
    ctx.strokeStyle = '#79d2ff'
    ctx.lineWidth = 1.8
    ctx.setLineDash([8, 6])
    ctx.strokeRect(crop.x, crop.y, crop.width, crop.height)
    ctx.restore()

    const handleSize = 7
    const handlePoints = [
      { x: crop.x, y: crop.y },
      { x: crop.x + crop.width / 2, y: crop.y },
      { x: crop.x + crop.width, y: crop.y },
      { x: crop.x, y: crop.y + crop.height / 2 },
      { x: crop.x + crop.width, y: crop.y + crop.height / 2 },
      { x: crop.x, y: crop.y + crop.height },
      { x: crop.x + crop.width / 2, y: crop.y + crop.height },
      { x: crop.x + crop.width, y: crop.y + crop.height },
    ]

    ctx.save()
    ctx.fillStyle = '#f4f8ff'
    ctx.strokeStyle = 'rgba(17, 28, 42, 0.84)'
    ctx.lineWidth = 1
    for (const point of handlePoints) {
      ctx.beginPath()
      ctx.rect(
        point.x - handleSize / 2,
        point.y - handleSize / 2,
        handleSize,
        handleSize,
      )
      ctx.fill()
      ctx.stroke()
    }
    ctx.restore()
  }, [])

  const drawOcrOverlay = useCallback((ctx: CanvasRenderingContext2D) => {
    for (const word of ocrWords) {
      ctx.save()
      ctx.strokeStyle = word.sensitive ? 'rgba(211, 65, 39, 0.95)' : 'rgba(35, 115, 205, 0.7)'
      ctx.fillStyle = word.sensitive ? 'rgba(211, 65, 39, 0.14)' : 'rgba(35, 115, 205, 0.1)'
      ctx.lineWidth = 1.5
      ctx.fillRect(word.x, word.y, word.width, word.height)
      ctx.strokeRect(word.x, word.y, word.width, word.height)
      ctx.restore()
    }
  }, [ocrWords])

  const drawCodeOverlay = useCallback((ctx: CanvasRenderingContext2D) => {
    for (const code of detectedCodes) {
      const { x, y, width, height } = code.rect
      const stroke =
        code.severity === 'critical'
          ? 'rgba(211, 65, 39, 0.95)'
          : code.severity === 'sensitive'
            ? 'rgba(214, 138, 20, 0.95)'
            : 'rgba(35, 115, 205, 0.8)'

      ctx.save()
      ctx.strokeStyle = stroke
      ctx.lineWidth = 3
      ctx.setLineDash([9, 6])
      ctx.strokeRect(x, y, width, height)
      ctx.restore()
    }
  }, [detectedCodes])

  const renderToContext = useCallback(
    (ctx: CanvasRenderingContext2D, withOverlay: boolean) => {
      if (!baseImage) {
        return
      }

      ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height)
      ctx.drawImage(baseImage, 0, 0)

      for (const annotation of annotations) {
        drawAnnotation(ctx, annotation)
      }

      if (draftAnnotation) {
        drawAnnotation(ctx, draftAnnotation)
      }

      if (selectedAnnotationId) {
        const selectedAnnotation = annotations.find((annotation) => annotation.id === selectedAnnotationId)
        if (selectedAnnotation) {
          drawSelectionOutline(ctx, selectedAnnotation)
        }
      }

      const activeCrop = draftCropRect ?? cropRect
      if (activeCrop) {
        drawCropOverlay(ctx, activeCrop)
      }

      if (withOverlay && showOcrOverlay) {
        drawOcrOverlay(ctx)
      }

      if (withOverlay) {
        drawCodeOverlay(ctx)
      }
    },
    [
      annotations,
      baseImage,
      cropRect,
      draftCropRect,
      draftAnnotation,
      drawAnnotation,
      drawCodeOverlay,
      drawCropOverlay,
      drawOcrOverlay,
      drawSelectionOutline,
      selectedAnnotationId,
      showOcrOverlay,
    ],
  )

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !baseImage) {
      return
    }

    canvas.width = baseImage.naturalWidth
    canvas.height = baseImage.naturalHeight

    const context = canvas.getContext('2d')
    if (!context) {
      return
    }

    renderToContext(context, true)
  }, [baseImage, renderToContext])

  const getCanvasPoint = useCallback((event: React.PointerEvent<HTMLCanvasElement>): Point | null => {
    const canvas = canvasRef.current
    if (!canvas) {
      return null
    }

    const rect = canvas.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) {
      return null
    }

    const scaleX = canvas.width / rect.width
    const scaleY = canvas.height / rect.height

    return {
      x: (event.clientX - rect.left) * scaleX,
      y: (event.clientY - rect.top) * scaleY,
    }
  }, [])

  const focusTextToolInput = useCallback(() => {
    window.requestAnimationFrame(() => {
      textToolInputRef.current?.focus()
      textToolInputRef.current?.select()
    })
  }, [])

  useEffect(() => {
    if (!quickEditorOpen || activeTool !== 'text') {
      return
    }

    focusTextToolInput()
  }, [activeTool, focusTextToolInput, quickEditorOpen])

  const commitTextAnnotationAt = useCallback(
    (point: Point | null, rawValue?: string): boolean => {
      const value = (rawValue ?? textPromptValue).trim()
      if (!point || value.length === 0) {
        return false
      }

      const nextId = createId()
      setAnnotations((prev) => [
        ...prev,
        {
          id: nextId,
          createdAt: Date.now(),
          type: 'text',
          x: point.x,
          y: point.y,
          value,
          color: accentColor,
        },
      ])
      setSelectedAnnotationId(nextId)
      setTextPromptPosition(null)
      setTextPromptValue('')
      setErrorMessage('')
      return true
    },
    [accentColor, textPromptValue],
  )

  const updateDraft = useCallback(
    (start: Point, end: Point) => {
      if (activeTool === 'crop' || activeTool === 'ocr-select') {
        if (!baseImage) {
          return
        }

        if (activeTool === 'ocr-select') {
          const rect = normalizeRect(
            start,
            {
              x: clamp(end.x, 0, baseImage.naturalWidth),
              y: clamp(end.y, 0, baseImage.naturalHeight),
            },
          )
          setDraftCropRect(rect)
          return
        }

        const snappedEnd = {
          x:
            Math.abs(end.x - baseImage.naturalWidth) <= SNAP_DISTANCE
              ? baseImage.naturalWidth
              : Math.abs(end.x) <= SNAP_DISTANCE
                ? 0
                : clamp(end.x, 0, baseImage.naturalWidth),
          y:
            Math.abs(end.y - baseImage.naturalHeight) <= SNAP_DISTANCE
              ? baseImage.naturalHeight
              : Math.abs(end.y) <= SNAP_DISTANCE
                ? 0
                : clamp(end.y, 0, baseImage.naturalHeight),
        }

        const ratioAdjustedEnd = applyAspectRatioToCrop(
          start,
          snappedEnd,
          cropAspect,
          baseImage.naturalWidth,
          baseImage.naturalHeight,
        )
        const rect = normalizeRect(start, ratioAdjustedEnd)
        const snappedRect = snapCropRectToEdges(rect, baseImage.naturalWidth, baseImage.naturalHeight)
        setDraftCropRect(snappedRect)
        return
      }

      if (isRectTool(activeTool)) {
        const rect = normalizeRect(start, end)
        const baseDraft: RectAnnotation = {
          id: 'draft',
          createdAt: Date.now(),
          type: activeTool,
          ...rect,
        }

        if (activeTool === 'highlight') {
          setDraftAnnotation({
            ...baseDraft,
            fillColor: hexToRgba(accentColor, 0.24),
            borderColor: accentColor,
          })
          return
        }

        if (activeTool === 'pixelate') {
          setDraftAnnotation({
            ...baseDraft,
            cellSize: 14,
            randomSeed: Math.floor(Math.random() * 100_000),
          })
          return
        }

        if (activeTool === 'border') {
          setDraftAnnotation({
            ...baseDraft,
            borderColor: accentColor,
            borderWidth: strokeWidth,
          })
          return
        }

        setDraftAnnotation(baseDraft)
        return
      }

      if (activeTool === 'arrow') {
        const controlPoint = arrowStyle === 'curved' ? getArrowControlPoint(start, end) : null
        setDraftAnnotation({
          id: 'draft',
          createdAt: Date.now(),
          type: 'arrow',
          x1: start.x,
          y1: start.y,
          x2: end.x,
          y2: end.y,
          color: accentColor,
          style: arrowStyle,
          controlX: controlPoint?.x,
          controlY: controlPoint?.y,
        })
        return
      }

      if (activeTool === 'strike') {
        setDraftAnnotation({
          id: 'draft',
          createdAt: Date.now(),
          type: 'strike',
          x1: start.x,
          y1: start.y,
          x2: end.x,
          y2: end.y,
          color: accentColor,
        })
      }
    },
    [accentColor, activeTool, arrowStyle, baseImage, cropAspect, strokeWidth],
  )

  const runOcrSelection = useCallback(async (selection: CropSelection) => {
    if (!baseImage) {
      return
    }

    const width = Math.max(1, Math.round(selection.width))
    const height = Math.max(1, Math.round(selection.height))
    const selectionCanvas = document.createElement('canvas')
    selectionCanvas.width = width
    selectionCanvas.height = height

    const selectionContext = selectionCanvas.getContext('2d')
    if (!selectionContext) {
      setErrorMessage('Could not initialize OCR selection canvas')
      return
    }

    selectionContext.drawImage(
      baseImage,
      selection.x,
      selection.y,
      selection.width,
      selection.height,
      0,
      0,
      width,
      height,
    )

    setErrorMessage('')
    setOcrSelectionRunning(true)
    setOcrStatus('Running OCR on selection...')
    setOcrSelectionResult({
      pending: true,
      text: 'Recognizing text...',
    })

    let worker: Awaited<ReturnType<typeof createWorker>> | null = null

    try {
      worker = await createWorker('eng', undefined, getLocalWorkerOptions())
      const result = await worker.recognize(selectionCanvas.toDataURL('image/png'))
      const extractedText = result.data.text.trim()
      const resultText = extractedText.length > 0 ? extractedText : 'No text detected in this area.'
      setOcrSelectionResult({
        pending: false,
        text: resultText,
      })
      setOcrStatus('OCR selection done')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'OCR selection failed'
      setErrorMessage(message)
      setOcrStatus('OCR selection error')
      setOcrSelectionResult(null)
    } finally {
      setOcrSelectionRunning(false)
      if (worker) {
        await worker.terminate()
      }
    }
  }, [baseImage])

  const commitDraft = useCallback(() => {
    if (draftCropRect) {
      if (!baseImage) {
        setDraftCropRect(null)
        return
      }

      const normalizedCrop = sanitizeCropSelection(
        draftCropRect,
        baseImage.naturalWidth,
        baseImage.naturalHeight,
      )

      if (!normalizedCrop || normalizedCrop.width < 6 || normalizedCrop.height < 6) {
        setDraftCropRect(null)
        return
      }

      if (activeTool === 'ocr-select') {
        setDraftCropRect(null)
        void runOcrSelection(normalizedCrop)
        return
      }

      setCropRect(normalizedCrop)
      setDraftCropRect(null)
      setActiveTool('select')
      return
    }

    if (!draftAnnotation) {
      return
    }

    if (draftAnnotation.type === 'arrow') {
      const length = Math.hypot(draftAnnotation.x2 - draftAnnotation.x1, draftAnnotation.y2 - draftAnnotation.y1)
      if (length < 8) {
        setDraftAnnotation(null)
        return
      }

      const nextId = createId()
      setAnnotations((prev) => [
        ...prev,
        {
          ...draftAnnotation,
          id: nextId,
        },
      ])
      setSelectedAnnotationId(nextId)
      setDraftAnnotation(null)
      return
    }

    if (draftAnnotation.type === 'strike') {
      const length = Math.hypot(draftAnnotation.x2 - draftAnnotation.x1, draftAnnotation.y2 - draftAnnotation.y1)
      if (length < 4) {
        setDraftAnnotation(null)
        return
      }

      const nextId = createId()
      setAnnotations((prev) => [
        ...prev,
        {
          ...draftAnnotation,
          id: nextId,
        },
      ])
      setSelectedAnnotationId(nextId)
      setDraftAnnotation(null)
      return
    }

    if ('width' in draftAnnotation && 'height' in draftAnnotation) {
      if (draftAnnotation.width < 4 || draftAnnotation.height < 4) {
        setDraftAnnotation(null)
        return
      }

      const nextId = createId()
      setAnnotations((prev) => [
        ...prev,
        {
          ...draftAnnotation,
          id: nextId,
        },
      ])
      setSelectedAnnotationId(nextId)
      setDraftAnnotation(null)
    }
  }, [activeTool, baseImage, draftAnnotation, draftCropRect, runOcrSelection])

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (!baseImage) {
        return
      }

      const point = getCanvasPoint(event)
      if (!point) {
        return
      }

      if (activeTool === 'select') {
        const hit = hitTestAnnotation(point, annotations)
        setSelectedAnnotationId(hit?.id ?? null)

        if (hit) {
          selectionDragRef.current = {
            id: hit.id,
            lastPoint: point,
          }
          event.currentTarget.setPointerCapture(event.pointerId)
        } else {
          selectionDragRef.current = null
        }
        return
      }

      if (activeTool === 'text') {
        selectionDragRef.current = null
        setSelectedAnnotationId(null)
        setTextPromptPosition(point)
        if (!commitTextAnnotationAt(point)) {
          setErrorMessage('Type text in the toolbar, then click the screenshot where it should appear.')
          focusTextToolInput()
        }
        return
      }

      selectionDragRef.current = null
      setSelectedAnnotationId(null)
      if (activeTool !== 'crop' && activeTool !== 'ocr-select') {
        setDraftCropRect(null)
      }
      if (activeTool === 'ocr-select') {
        setOcrSelectionResult(null)
      }
      drawingStartRef.current = point
      drawingRef.current = true
      updateDraft(point, point)
      event.currentTarget.setPointerCapture(event.pointerId)
    },
    [activeTool, annotations, baseImage, commitTextAnnotationAt, focusTextToolInput, getCanvasPoint, updateDraft],
  )

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (activeTool === 'select') {
        const draggingSelection = selectionDragRef.current
        if (!draggingSelection) {
          return
        }

        const point = getCanvasPoint(event)
        if (!point) {
          return
        }

        const deltaX = point.x - draggingSelection.lastPoint.x
        const deltaY = point.y - draggingSelection.lastPoint.y
        if (deltaX === 0 && deltaY === 0) {
          return
        }

        selectionDragRef.current = {
          ...draggingSelection,
          lastPoint: point,
        }

        setAnnotations((prev) =>
          prev.map((annotation) =>
            annotation.id === draggingSelection.id
              ? moveAnnotationBy(annotation, deltaX, deltaY)
              : annotation,
          ),
        )
        return
      }

      if (!drawingRef.current) {
        return
      }

      const start = drawingStartRef.current
      if (!start) {
        return
      }

      const point = getCanvasPoint(event)
      if (!point) {
        return
      }

      updateDraft(start, point)
    },
    [activeTool, getCanvasPoint, updateDraft],
  )

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (selectionDragRef.current) {
        selectionDragRef.current = null
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId)
        }
        return
      }

      if (!drawingRef.current) {
        return
      }

      drawingRef.current = false
      drawingStartRef.current = null
      commitDraft()
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
    },
    [commitDraft],
  )

  const handleUndo = useCallback(() => {
    setAnnotations((prev) => prev.slice(0, -1))
    setSelectedAnnotationId(null)
  }, [])

  const handleDeleteSelected = useCallback(() => {
    if (!selectedAnnotationId) {
      return
    }

    setAnnotations((prev) => prev.filter((annotation) => annotation.id !== selectedAnnotationId))
    setSelectedAnnotationId(null)
  }, [selectedAnnotationId])

  const runOcr = useCallback(async () => {
    if (!imageSource || !baseImage || ocrRunning) {
      return
    }

    setErrorMessage('')
    setOcrRunning(true)
    setOcrProgress(0)
    setOcrStatus('Initializing OCR worker...')

    try {
      const worker = await createWorker('eng', undefined, {
        ...getLocalWorkerOptions(),
        logger: (message: LoggerMessage) => {
          if (typeof message.progress === 'number') {
            setOcrProgress(message.progress)
          }

          if (message.status) {
            setOcrStatus(message.status)
          }
        },
      })

      // `blocks` has to be requested explicitly: recognize() defaults to
      // `{ text: true }`, and without this the word boxes below are always
      // empty - which is what kept sensitive-token detection from ever firing.
      const result = await worker.recognize(imageSource, {}, { text: true, blocks: true })
      await worker.terminate()

      const recognizedWords = collectWordsFromBlocks(result.data.blocks)
      const words: OcrWord[] = recognizedWords
        .map((word, index) => {
          const rect = bboxToRect(word.bbox)

          return {
            id: `${index}-${word.text}-${word.bbox.x0}-${word.bbox.y0}`,
            text: word.text,
            confidence: word.confidence,
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            sensitive: isSensitiveToken(word.text),
          }
        })
        .filter((word) => word.text.trim().length > 0 && word.width > 0 && word.height > 0)

      setOcrWords(words)
      setOcrText(result.data.text.trim())
      setOcrStatus(`OCR done (${words.length} words)`)
      setOcrProgress(1)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'OCR failed'
      setErrorMessage(message)
      setOcrStatus('OCR error')
    } finally {
      setOcrRunning(false)
    }
  }, [baseImage, imageSource, ocrRunning])

  useEffect(() => {
    if (!autoOcrEnabled || !imageSource || !baseImage || ocrRunning) {
      return
    }

    if (autoOcrProcessedSource === imageSource) {
      return
    }

    setAutoOcrProcessedSource(imageSource)
    void runOcr()
  }, [autoOcrEnabled, autoOcrProcessedSource, baseImage, imageSource, ocrRunning, runOcr])

  const runCodeScan = useCallback(async () => {
    if (!baseImage) {
      return
    }

    setCodeScanRunning(true)
    setCodeScanError('')

    try {
      const codes = await scanCodesFromImage(baseImage)
      setDetectedCodes(codes)
      setRevealedCodeIds([])
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Barcode scan failed'
      setDetectedCodes([])
      setCodeScanError(message)
    } finally {
      setCodeScanRunning(false)
    }
  }, [baseImage])

  // Runs independently of OCR: the WASM decoder is much faster than Tesseract,
  // so codes surface while text recognition is still working.
  useEffect(() => {
    if (!imageSource || !baseImage || codeScanRunning) {
      return
    }

    if (codeScanProcessedSource === imageSource) {
      return
    }

    setCodeScanProcessedSource(imageSource)
    void runCodeScan()
  }, [baseImage, codeScanProcessedSource, codeScanRunning, imageSource, runCodeScan])

  const sensitiveOcrWords = useMemo(() => ocrWords.filter((word) => word.sensitive), [ocrWords])

  // Always blackout, never blur: blur and pixelate leave structure behind, and
  // a redaction that merely looks unreadable is not the same as one that is.
  const maskRects = useCallback((rects: CodeRect[]) => {
    if (rects.length === 0) {
      return
    }

    const masks: Annotation[] = rects.map((rect) => ({
      id: createId(),
      createdAt: Date.now(),
      type: 'blackout' as const,
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    }))

    setAnnotations((prev) => [...prev, ...masks])
    setSelectedAnnotationId(null)
  }, [])

  const maskCodes = useCallback(
    (codes: DetectedCode[]) => {
      maskRects(codes.map((code) => code.rect))
    },
    [maskRects],
  )

  const handleMaskAllSensitiveCodes = useCallback(() => {
    maskCodes(detectedCodes.filter((code) => code.severity !== 'benign'))
  }, [detectedCodes, maskCodes])

  const handleMaskSensitiveWords = useCallback(() => {
    // OCR boxes hug the glyphs, so a mask drawn exactly on the box can leave
    // ascenders and descenders poking out. Pad by a fraction of the line height.
    const padding = 0.18

    maskRects(
      sensitiveOcrWords.map((word) => ({
        x: word.x - word.height * padding,
        y: word.y - word.height * padding,
        width: word.width + word.height * padding * 2,
        height: word.height * (1 + padding * 2),
      })),
    )
  }, [maskRects, sensitiveOcrWords])

  const handleCopyCodeText = useCallback(async (code: DetectedCode) => {
    try {
      await navigator.clipboard.writeText(code.text)
      setCopyStatus('Payload copied')
    } catch {
      setCopyStatus('Clipboard copy failed')
    }
  }, [])

  const handleToggleCodeReveal = useCallback((codeId: string) => {
    setRevealedCodeIds((prev) =>
      prev.includes(codeId) ? prev.filter((id) => id !== codeId) : [...prev, codeId],
    )
  }, [])

  const sensitiveCodeCount = detectedCodes.filter((code) => code.severity !== 'benign').length

  const exportBlob = useCallback(async (): Promise<Blob | null> => {
    if (!baseImage) {
      return null
    }

    const offscreen = document.createElement('canvas')
    offscreen.width = baseImage.naturalWidth
    offscreen.height = baseImage.naturalHeight

    const context = offscreen.getContext('2d')
    if (!context) {
      return null
    }

    context.drawImage(baseImage, 0, 0)
    for (const annotation of annotations) {
      drawAnnotation(context, annotation)
    }

    const normalizedCrop = cropRect
      ? sanitizeCropSelection(cropRect, offscreen.width, offscreen.height)
      : null
    const outputCanvas = normalizedCrop ? document.createElement('canvas') : offscreen

    if (normalizedCrop) {
      outputCanvas.width = Math.round(normalizedCrop.width)
      outputCanvas.height = Math.round(normalizedCrop.height)
      const outputCtx = outputCanvas.getContext('2d')
      if (!outputCtx) {
        return null
      }

      outputCtx.drawImage(
        offscreen,
        normalizedCrop.x,
        normalizedCrop.y,
        normalizedCrop.width,
        normalizedCrop.height,
        0,
        0,
        normalizedCrop.width,
        normalizedCrop.height,
      )
    }

    return new Promise((resolve) => {
      outputCanvas.toBlob((blob) => resolve(blob), 'image/png')
    })
  }, [annotations, baseImage, cropRect, drawAnnotation])

  const createPngFilename = useCallback(() => {
    const now = new Date().toISOString().replace(/[:.]/g, '-')
    return `vanilla-shot-${now}.png`
  }, [])

  const downloadBlob = useCallback(
    (blob: Blob, fileName = createPngFilename()): string => {
      const link = document.createElement('a')
      const url = URL.createObjectURL(blob)

      link.href = url
      link.download = fileName
      link.click()
      URL.revokeObjectURL(url)
      return fileName
    },
    [createPngFilename],
  )

  const downloadTextFile = useCallback((content: string, fileName: string): string => {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
    const link = document.createElement('a')
    const url = URL.createObjectURL(blob)

    link.href = url
    link.download = fileName
    link.click()
    URL.revokeObjectURL(url)
    return fileName
  }, [])

  const buildAttachedNoteText = useCallback(() => {
    const preferred = reportCommittedText.trim()
    if (preferred.length > 0) {
      return preferred
    }

    return reportDraft.trim()
  }, [reportCommittedText, reportDraft])

  const saveBlobToDisk = useCallback(async (blob: Blob, noteText: string): Promise<SavedCaptureResult> => {
    if (isDesktopRuntime()) {
      const dataUrl = await toDataUrl(blob)
      return invoke<SavedCaptureResult>('save_capture_png', { dataUrl, noteText })
    }

    const imagePath = createPngFilename()
    downloadBlob(blob, imagePath)

    let notePath: string | null = null
    if (noteText.trim()) {
      notePath = imagePath.replace(/\.png$/i, '.txt')
      downloadTextFile(noteText, notePath)
    }

    return {
      imagePath,
      notePath,
    }
  }, [createPngFilename, downloadBlob, downloadTextFile])

  const copyBlobToClipboard = useCallback(async (blob: Blob): Promise<void> => {
    if (isDesktopRuntime()) {
      const dataUrl = await toDataUrl(blob)

      try {
        await invoke('copy_capture_png', { dataUrl })
        return
      } catch (nativeError) {
        if (!navigator.clipboard || typeof ClipboardItem === 'undefined') {
          const message = nativeError instanceof Error ? nativeError.message : 'Clipboard write failed'
          throw new Error(message)
        }
      }
    }

    if (!navigator.clipboard || typeof ClipboardItem === 'undefined') {
      throw new Error('Clipboard write is not available in this browser')
    }

    await navigator.clipboard.write([
      new ClipboardItem({
        'image/png': blob,
      }),
    ])
  }, [])

  const handleCopy = useCallback(async () => {
    const blob = await exportBlob()
    if (!blob) {
      setErrorMessage('Could not render image for clipboard')
      return
    }

    try {
      await copyBlobToClipboard(blob)
      setCopyStatus('Copied PNG to clipboard')
      setTimeout(() => setCopyStatus(''), 1800)
      setErrorMessage('')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Clipboard write failed'
      setErrorMessage(message)
    }
  }, [copyBlobToClipboard, exportBlob])

  const handleCopyOcrSelectionText = useCallback(async () => {
    const text = ocrSelectionResult?.text?.trim() ?? ''
    if (!text || ocrSelectionResult?.pending) {
      return
    }

    if (!navigator.clipboard?.writeText) {
      setErrorMessage('Clipboard text write is not available')
      return
    }

    try {
      await navigator.clipboard.writeText(text)
      setCopyStatus('Copied OCR text to clipboard')
      setTimeout(() => setCopyStatus(''), 1600)
      setErrorMessage('')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not copy OCR text'
      setErrorMessage(message)
    }
  }, [ocrSelectionResult])

  const handleTextToolSubmit = useCallback(() => {
    if (commitTextAnnotationAt(textPromptPosition)) {
      return
    }

    if (!textPromptValue.trim()) {
      setErrorMessage('Type the text first, then click the screenshot where it should appear.')
      focusTextToolInput()
      return
    }

    setErrorMessage('Click the screenshot where the text should appear, then press Add.')
  }, [commitTextAnnotationAt, focusTextToolInput, textPromptPosition, textPromptValue])

  const handleCutSelection = useCallback(async () => {
    if (!baseImage) {
      setErrorMessage('No image loaded')
      return
    }

    const normalizedCrop = cropRect
      ? sanitizeCropSelection(cropRect, baseImage.naturalWidth, baseImage.naturalHeight)
      : null

    if (!normalizedCrop || normalizedCrop.width < 2 || normalizedCrop.height < 2) {
      setErrorMessage('Select crop area first, then press Cmd/Ctrl + X')
      return
    }

    const blob = await exportBlob()
    if (!blob) {
      setErrorMessage('Could not render cropped image for clipboard')
      return
    }

    try {
      await copyBlobToClipboard(blob)
      setCopyStatus('Cut selection copied to clipboard')
      setTimeout(() => setCopyStatus(''), 1800)
      setErrorMessage('')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Clipboard write failed'
      setErrorMessage(message)
    }
  }, [baseImage, copyBlobToClipboard, cropRect, exportBlob])

  const handleOpenQuickCommitPath = useCallback(async () => {
    if (!quickCommitFx || !isDesktopRuntime()) {
      return
    }

    try {
      await openMemoryPathInFinder(quickCommitFx.imagePath)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not open Finder'
      setErrorMessage(message)
    }
  }, [quickCommitFx])

  const showQuickCommitFx = useCallback(async (
    blob: Blob,
    savedCapture: SavedCaptureResult,
    noteText: string,
    clipboardState: QuickCommitFx['clipboardState'],
  ) => {
    const previewUrl = await toDataUrl(blob)
    setQuickCommitFx({
      id: createId(),
      previewUrl,
      imagePath: savedCapture.imagePath,
      notePath: savedCapture.notePath,
      noteText,
      clipboardState,
    })
  }, [])

  const handleExport = useCallback(async () => {
    const blob = await exportBlob()
    if (!blob) {
      setErrorMessage('Could not generate PNG export')
      return
    }

    try {
      const noteText = buildAttachedNoteText()
      const savedCapture = await saveBlobToDisk(blob, noteText)
      await showQuickCommitFx(blob, savedCapture, noteText, 'skipped')
      setIsSavingAnimation(true)
      setTimeout(() => {
        setIsSavingAnimation(false)
        setErrorMessage('')
      }, 380)
      setErrorMessage('')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not save PNG'
      setErrorMessage(message)
    }
  }, [buildAttachedNoteText, exportBlob, saveBlobToDisk, showQuickCommitFx])

  const handleQuickCommit = useCallback(async () => {
    const blob = await exportBlob()
    if (!blob) {
      setErrorMessage('Could not render image for quick save')
      return
    }

    let savedCapture: SavedCaptureResult | null = null
    const noteText = buildAttachedNoteText()
    try {
      savedCapture = await saveBlobToDisk(blob, noteText)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not save image'
      setErrorMessage(message)
      return
    }

    let copyFailureMessage = ''
    try {
      await copyBlobToClipboard(blob)
    } catch (error) {
      copyFailureMessage = error instanceof Error ? error.message : 'Could not copy image to clipboard'
    }

    try {
      if (savedCapture) {
        await showQuickCommitFx(blob, savedCapture, noteText, copyFailureMessage.length === 0 ? 'copied' : 'failed')
      }
    } catch {
      // Non-critical: saved image is already persisted.
    }

    // Play a discreet "snap/save" sound
    try {
      const audioCtx = new window.AudioContext()
      const oscillator = audioCtx.createOscillator()
      const gainNode = audioCtx.createGain()
      
      oscillator.type = 'sine'
      oscillator.frequency.setValueAtTime(800, audioCtx.currentTime)
      oscillator.frequency.exponentialRampToValueAtTime(1200, audioCtx.currentTime + 0.05)
      
      gainNode.gain.setValueAtTime(0, audioCtx.currentTime)
      gainNode.gain.linearRampToValueAtTime(0.1, audioCtx.currentTime + 0.02)
      gainNode.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.1)
      
      oscillator.connect(gainNode)
      gainNode.connect(audioCtx.destination)
      
      oscillator.start()
      oscillator.stop(audioCtx.currentTime + 0.1)
    } catch {
      // ignore audio context errors
    }

    setIsSavingAnimation(true)
    setTimeout(() => {
      setIsSavingAnimation(false)
      setErrorMessage('')

      if (isDedicatedQuickWindow) {
        void closeCurrentDesktopWindow()
        return
      }

      setQuickEditorOpen(false)
    }, 380)
  }, [buildAttachedNoteText, closeCurrentDesktopWindow, copyBlobToClipboard, exportBlob, isDedicatedQuickWindow, saveBlobToDisk, showQuickCommitFx])

  const handleZoomIn = useCallback(() => {
    setZoomLevel((value) => clamp(value + 0.15, MIN_ZOOM, MAX_ZOOM))
  }, [])

  const handleZoomOut = useCallback(() => {
    setZoomLevel((value) => clamp(value - 0.15, MIN_ZOOM, MAX_ZOOM))
  }, [])

  const handleZoomReset = useCallback(() => {
    setZoomLevel(getSuggestedQuickZoom(baseImage, quickMonitorScale || window.devicePixelRatio || 1))
  }, [baseImage, quickMonitorScale])

  const stopReportCapture = useCallback(async (preserveAudio = true): Promise<Blob | null> => {
    reportRecognitionRef.current?.stop()
    reportRecognitionRef.current = null

    const recorder = reportRecorderRef.current
    if (!recorder || recorder.state === 'inactive') {
      reportRecorderRef.current = null
      reportStreamRef.current?.getTracks().forEach((track) => track.stop())
      reportStreamRef.current = null
      reportAudioChunksRef.current = preserveAudio ? reportAudioChunksRef.current : []
      if (!preserveAudio) {
        reportAudioBlobRef.current = null
        setReportAudioBlob(null)
      }
      setReportRecording(false)
      return preserveAudio ? reportAudioBlobRef.current : null
    }

    const finalizedBlob = await new Promise<Blob | null>((resolve) => {
      reportStopResolverRef.current = resolve
      recorder.stop()
    })

    if (!preserveAudio) {
      reportAudioBlobRef.current = null
      setReportAudioBlob(null)
      return null
    }

    return finalizedBlob
  }, [])

  const openReportComposer = useCallback(async () => {
    quickBlurGuardUntilRef.current = Date.now() + 8000
    flushSync(() => {
      setReportOpen(true)
      setReportDetailsOpen(false)
      setReportStage('recording')
      setReportDraft(reportCommittedText)
      setReportAudioBlob(null)
      reportAudioBlobRef.current = null
      setReportSubmitting(false)
      setReportStatus('Preparing note tools...')
      setReportSpeechState({
        detail: 'Connecting voice preview...',
        tone: 'working',
      })
      setReportMicState({
        detail: 'Requesting microphone access...',
        tone: 'working',
      })
      setReportPayloadState(idleReportDebugState('Waiting for note text'))
      setReportApiState(idleReportDebugState(`Ready: ${NOTE_STORAGE_LABEL}`))
      setErrorMessage('')
    })
    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => {
        resolve()
      })
    })
    await stopReportCapture(false)

    const speechCtor = (
      window as Window & {
        SpeechRecognition?: SpeechRecognitionConstructor
        webkitSpeechRecognition?: SpeechRecognitionConstructor
      }
    ).SpeechRecognition
      ?? (
        window as Window & {
          SpeechRecognition?: SpeechRecognitionConstructor
          webkitSpeechRecognition?: SpeechRecognitionConstructor
        }
      ).webkitSpeechRecognition

    let speechReady = false
    let micReady = false

    if (speechCtor) {
      try {
        const recognition = new speechCtor()
        recognition.continuous = true
        recognition.interimResults = true
        recognition.lang = 'en-US'
        recognition.onresult = (event) => {
          const transcript = Array.from(event.results)
            .flatMap((result) => Array.from(result))
            .map((result) => result.transcript)
            .join(' ')
            .trim()
          setReportDraft(transcript)
        }
        recognition.onerror = (event) => {
          const nextMessage = event.error
            ? `Live preview unavailable: ${event.error}`
            : 'Live preview unavailable in this runtime'
          setReportSpeechState({
            detail: nextMessage,
            tone: 'warn',
          })
        }
        recognition.onend = () => {
          reportRecognitionRef.current = null
        }
        recognition.start()
        reportRecognitionRef.current = recognition
        speechReady = true
        setReportSpeechState({
          detail: 'Connected. Live speech preview is active.',
          tone: 'ok',
        })
      } catch {
        speechReady = false
        setReportSpeechState({
          detail: 'Voice preview is unavailable in this runtime.',
          tone: 'warn',
        })
      }
    } else {
      setReportSpeechState({
        detail: 'Voice preview is not supported here.',
        tone: 'warn',
      })
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const recorder = new MediaRecorder(stream)
      reportStreamRef.current = stream
      reportAudioChunksRef.current = []
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          reportAudioChunksRef.current.push(event.data)
        }
      }
      recorder.onstop = () => {
        const nextBlob =
          reportAudioChunksRef.current.length > 0
            ? new Blob(reportAudioChunksRef.current, { type: recorder.mimeType || 'audio/webm' })
            : null
        reportAudioBlobRef.current = nextBlob
        setReportAudioBlob(nextBlob)
        reportAudioChunksRef.current = []
        reportRecorderRef.current = null
        reportStreamRef.current?.getTracks().forEach((track) => track.stop())
        reportStreamRef.current = null
        setReportRecording(false)
        reportStopResolverRef.current?.(nextBlob)
        reportStopResolverRef.current = null
      }
      recorder.start()
      reportRecorderRef.current = recorder
      setReportRecording(true)
      micReady = true
      quickBlurGuardUntilRef.current = Date.now() + 2000
      setReportMicState({
        detail: `Connected. Recording in ${recorder.mimeType || 'audio/webm'}.`,
        tone: 'ok',
      })
    } catch {
      setReportRecording(false)
      micReady = false
      quickBlurGuardUntilRef.current = Date.now() + 1500
      setReportMicState({
        detail: 'Microphone unavailable or permission denied.',
        tone: 'error',
      })
    }

    if (micReady && speechReady) {
      setReportStatus('Recording now. Speak naturally or type, then review the note.')
      return
    }

    if (micReady) {
      setReportStatus('Recording now. Voice preview is unavailable, so type edits below if needed.')
      return
    }

    if (speechReady) {
      setReportStatus('Mic capture unavailable. Type below or use live preview only.')
      return
    }

    setReportStatus('Mic unavailable. Type below to attach a note to this screenshot.')
  }, [reportCommittedText, stopReportCapture])

  const handleReportPrimaryEnter = useCallback(async () => {
    const nextText = reportDraft.trim()
    if (!nextText) {
      setReportPayloadState({
        detail: 'Add note text or speech before reviewing it.',
        tone: 'error',
      })
      setErrorMessage('Add note text or speak before attaching it')
      return
    }

    setReportPayloadState({
      detail: 'Preparing note preview...',
      tone: 'working',
    })
    const nextAudioBlob = await stopReportCapture(true)
    setReportCommittedText(nextText)
    setReportStage('preview')
    setErrorMessage('')
    setReportPayloadState({
      detail: nextAudioBlob
        ? `Ready: note text + voice preview (${formatBlobSize(nextAudioBlob.size)})`
        : 'Ready: note text',
      tone: 'ok',
    })
    setReportStatus(
      nextAudioBlob
        ? 'Voice note transcribed. Review the text, then use this note.'
        : 'Note ready. Review it, then use this note.',
    )
  }, [reportDraft, stopReportCapture])

  const handleReportApplyNote = useCallback(async () => {
    const nextText = reportCommittedText.trim()
    if (!nextText) {
      setReportPayloadState({
        detail: 'Confirm the note text before attaching it.',
        tone: 'error',
      })
      setErrorMessage('Confirm the note text before attaching it')
      return
    }

    if (reportSubmitting) {
      return
    }

    setReportSubmitting(true)
    setReportStatus('Attaching note...')
    setReportPayloadState({
      detail: 'Attaching note to this screenshot...',
      tone: 'working',
    })
    setReportApiState({
      detail: `Ready: ${NOTE_STORAGE_LABEL}`,
      tone: 'working',
    })
    setErrorMessage('')

    try {
      setReportPayloadState({
        detail: reportAudioBlobRef.current
          ? `Ready: note text + voice preview (${formatBlobSize(reportAudioBlobRef.current.size)})`
          : 'Ready: note text only',
        tone: 'ok',
      })
      setReportApiState({
        detail: `Ready: ${NOTE_STORAGE_LABEL}`,
        tone: 'ok',
      })

      setReportStatus('Ready to add note')
      setCopyStatus('Note attached to this capture')
      setTimeout(() => setCopyStatus(''), 1800)
      setReportSubmitting(false)
      setTimeout(() => {
        quickBlurGuardUntilRef.current = 0
        setReportOpen(false)
        setReportDetailsOpen(false)
        setReportStage('recording')
        setReportDraft(nextText)
        setReportAudioBlob(null)
        reportAudioBlobRef.current = null
        setReportRecording(false)
      }, 180)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      setReportStatus(`Note failed: ${message}`)
      setReportApiState({
        detail: `Failed: ${message}`,
        tone: 'error',
      })
      setErrorMessage(`Note failed: ${message}`)
      quickBlurGuardUntilRef.current = Date.now() + 1500
      setReportSubmitting(false)
    }
  }, [reportCommittedText, reportSubmitting])

  const closeReportComposer = useCallback(() => {
    quickBlurGuardUntilRef.current = 0
    void stopReportCapture(false)
    setReportOpen(false)
    setReportDetailsOpen(false)
    setReportStage('recording')
    setReportDraft(reportCommittedText)
    setReportAudioBlob(null)
    reportAudioBlobRef.current = null
    setReportSubmitting(false)
    setReportStatus('Ready to add note')
    resetReportDebugState()
  }, [reportCommittedText, resetReportDebugState, stopReportCapture])

  useEffect(
    () => () => {
      void stopReportCapture(false)
    },
    [stopReportCapture],
  )

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const activeElement = document.activeElement
      const isTypingTarget =
        activeElement instanceof HTMLInputElement ||
        activeElement instanceof HTMLTextAreaElement ||
        (activeElement instanceof HTMLElement && activeElement.isContentEditable)

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        handleUndo()
        return
      }

      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key === '1') {
        event.preventDefault()
        void handleCaptureScreen()
        return
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void handleExport()
        return
      }

      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'c') {
        if (isTypingTarget) {
          return
        }

        if (ocrSelectionResult?.text) {
          event.preventDefault()
          void handleCopyOcrSelectionText()
          return
        }

        if (!baseImage) {
          return
        }

        event.preventDefault()
        void handleCopy()
        return
      }

      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'x') {
        if (isTypingTarget) {
          return
        }

        if (!baseImage) {
          return
        }

        event.preventDefault()
        void handleCutSelection()
        return
      }

      if (!event.metaKey && !event.ctrlKey && !event.altKey && (event.key === 'Delete' || event.key === 'Backspace')) {
        if (isTypingTarget) {
          return
        }

        event.preventDefault()
        handleDeleteSelected()
        return
      }

      if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key === 'Escape' && ocrSelectionResult) {
        event.preventDefault()
        setOcrSelectionResult(null)
        return
      }

      if (reportOpen && !event.metaKey && !event.ctrlKey && !event.altKey && event.key === 'Enter') {
        event.preventDefault()
        if (reportStage === 'recording') {
          void handleReportPrimaryEnter()
        } else {
          void handleReportApplyNote()
        }
        return
      }

      if (
        quickEditorOpen &&
        !reportOpen &&
        !isTypingTarget &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        event.key === 'Enter'
      ) {
        event.preventDefault()
        void handleQuickCommit()
        return
      }

      if (reportOpen && event.key === 'Escape') {
        event.preventDefault()
        closeReportComposer()
        return
      }

      if (quickEditorOpen && event.key === 'Escape') {
        if (isTypingTarget) {
          return
        }

        event.preventDefault()
        
        if (drawingRef.current || draftAnnotation || draftCropRect || selectionDragRef.current) {
          drawingRef.current = false
          selectionDragRef.current = null
          setDraftAnnotation(null)
          setDraftCropRect(null)
          return
        }

        if (activeTool === 'text' && (textPromptPosition || textPromptValue.trim().length > 0)) {
          setTextPromptPosition(null)
          setTextPromptValue('')
          return
        }
        
        if (selectedAnnotationId) {
          setSelectedAnnotationId(null)
          return
        }

        if (cropRect) {
          setCropRect(null)
          return
        }
        
        dismissQuickEditor()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    activeTool,
    baseImage,
    cropRect,
    draftAnnotation,
    draftCropRect,
    dismissQuickEditor,
    handleCaptureScreen,
    handleCopy,
    handleCopyOcrSelectionText,
    handleCutSelection,
    handleDeleteSelected,
    handleExport,
    handleQuickCommit,
    handleReportPrimaryEnter,
    handleReportApplyNote,
    handleUndo,
    closeReportComposer,
    ocrSelectionResult,
    quickEditorOpen,
    reportOpen,
    reportStage,
    selectedAnnotationId,
    textPromptPosition,
    textPromptValue,
  ])

  const toolButtons = [
    ['select', <MousePointer2 size={15} key="select" />],
    ['crop', <Crop size={15} key="crop" />],
    ['ocr-select', <ScanText size={15} key="ocr-select" />],
    ['arrow', <ArrowRight size={15} key="arrow" />],
    ['border', <SquareDashed size={15} key="border" />],
    ['pixelate', <ScanText size={15} key="pixelate" />],
    ['blackout', <span key="blackout" className="glyph-blackout" aria-hidden />],
    ['blur', <Eye size={15} key="blur" />],
    ['highlight', <Highlighter size={15} key="highlight" />],
    ['strike', <Slash size={15} key="strike" />],
    ['text', <Type size={15} key="text" />],
  ] as [Tool, React.ReactNode][]
  const quickCaptureTools: Tool[] = ['select', 'crop', 'ocr-select']
  const quickAnnotateTools: Tool[] = ['border', 'arrow', 'strike', 'highlight', 'text', 'pixelate', 'blur', 'blackout']
  const effectiveQuickMonitorScale = quickMonitorScale || window.devicePixelRatio || 1
  const quickCanvasLogicalWidth = baseImage
    ? Math.max(1, Math.round((baseImage.naturalWidth / effectiveQuickMonitorScale) * zoomLevel))
    : QUICK_WINDOW_MIN_WIDTH
  const quickCanvasLogicalHeight = baseImage
    ? Math.max(1, Math.round((baseImage.naturalHeight / effectiveQuickMonitorScale) * zoomLevel))
    : QUICK_WINDOW_MIN_HEIGHT
  const showQuickColorControls =
    activeTool === 'arrow' ||
    activeTool === 'border' ||
    activeTool === 'highlight' ||
    activeTool === 'strike' ||
    activeTool === 'text'
  const showQuickStrokeControls = activeTool === 'border' || activeTool === 'strike' || activeTool === 'arrow'
  const attachedNoteText = buildAttachedNoteText()
  const hasAttachedNote = attachedNoteText.length > 0
  const hasActiveReportStatus =
    reportStatus !== 'Ready to add note' || reportOpen || reportRecording || reportSubmitting
  const quickToastMessage =
    errorMessage ||
    (memoryNotice?.tone === 'error' ? memoryNotice.detail : '') ||
    copyStatus ||
    (hasActiveReportStatus ? reportStatus : '')
  const quickToastTone =
    errorMessage || memoryNotice?.tone === 'error' || reportStatus.startsWith('Note failed:') ? 'error' : 'ok'
  const quickShareStatus = reportSubmitting
    ? 'Attaching note...'
    : reportOpen
      ? 'Note draft ready'
      : hasAttachedNote
        ? 'Note attached'
      : cropRect
        ? 'Crop ready to save'
        : annotations.length > 0
          ? `${annotations.length} ${annotations.length === 1 ? 'edit' : 'edits'} ready`
          : 'Screenshot ready'
  const textToolPlacementHint = textPromptPosition
    ? `Ready at ${Math.round(textPromptPosition.x)}, ${Math.round(textPromptPosition.y)}`
    : 'Type text here, then click the screenshot.'
  const showOcrDock = activeTool === 'ocr-select' || Boolean(ocrSelectionResult)
  const ocrDockText = ocrSelectionResult?.text ?? ''
  const ocrDockPending = Boolean(ocrSelectionResult?.pending)
  const reportIsTextOnly = reportMicState.tone === 'error' && !reportRecording && !reportAudioBlob
  const reportCompactHint = reportStatus.startsWith('Note failed:')
    ? reportStatus
    : reportStage === 'preview'
      ? reportSubmitting
        ? 'Attaching...'
        : 'Review and use this note.'
      : reportRecording
        ? 'Speak or type, then review.'
        : reportIsTextOnly
          ? 'Type your note.'
          : 'Starting microphone...'
  const reportDebugItems = [
    { key: 'speech', label: 'Voice Preview', icon: <ScanText size={14} />, state: reportSpeechState },
    { key: 'mic', label: 'Microphone', icon: <Mic size={14} />, state: reportMicState },
    { key: 'payload', label: 'Note Text', icon: <Check size={14} />, state: reportPayloadState },
    { key: 'api', label: 'Save Target', icon: <FolderOpen size={14} />, state: reportApiState },
  ]
  const desktopRuntime = isDesktopRuntime()

  const screenRecordingStatus = !desktopRuntime
    ? { tone: 'unknown' as const, label: 'Desktop only' }
    : screenRecordingGranted === null
      ? { tone: 'unknown' as const, label: 'Unknown' }
      : screenRecordingGranted
        ? { tone: 'ok' as const, label: 'Granted' }
        : { tone: 'bad' as const, label: 'Not granted' }
  const launcherFeedback = memoryNotice ?? (errorMessage ? { tone: 'error' as const, detail: errorMessage } : null)
  const hasMemoryStats = Boolean(memoryStatus?.stats)
  const quickMemoryActionLabel = memoryStatus?.recording
    ? 'Stop'
    : memoryCountdownValue !== null
      ? `Starting ${memoryCountdownValue}…`
      : 'Record'
  const quickMemoryBannerText = memoryStatus?.recording
    ? `Recording memory for ${formatElapsedTimer(memoryRecordingElapsedSecs)}. Stop here or from the menu bar > Stop Memory.`
    : 'Start continuous local memory capture from this bar or from the menu bar.'
  const showCornerMemoryHud =
    isDedicatedQuickWindow &&
    memoryCornerHudOpen &&
    !quickEditorOpen &&
    (memoryActionLoading || Boolean(memoryStatus?.recording) || Boolean(memoryStopSummary))
  const cornerMemoryHudPrimaryLabel = memoryActionLoading
    ? memoryStatus?.recording
      ? 'Stopping memory recording…'
      : 'Starting memory recording…'
    : memoryStatus?.recording
    ? `Memory recording · ${formatElapsedTimer(memoryRecordingElapsedSecs)}`
    : memoryStopSummary
      ? `Recording saved (${memoryStopSummary.elapsedLabel})`
      : 'Memory ready'
  const cornerMemoryHudSecondaryLabel = memoryActionLoading
    ? 'Updating local screen memory state...'
    : memoryStatus?.recording
    ? 'Recording locally in the background. Stop here or from the menu bar.'
    : memoryStopSummary
      ? `${memoryStopSummary.frameCount} frames · ${memoryStopSummary.segmentCount} segments saved locally.`
      : 'Screen memory is idle.'
  const cornerMemoryHudActionLabel = memoryStatus?.recording ? 'Stop' : 'Resume'
  return (
    <div className={`app-shell ${quickEditorOpen || showCornerMemoryHud ? 'quick-mode' : ''} ${showCornerMemoryHud ? 'memory-hud-mode' : ''}`}>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/bmp"
        onChange={handleFileSelect}
        hidden
      />

      {!quickEditorOpen && !isDedicatedQuickWindow && !showCornerMemoryHud && (
        <main className="settings-shell">
          {launcherFeedback && (
            <div className={`settings-banner ${launcherFeedback.tone}`} role="status" aria-live="polite">
              {launcherFeedback.detail}
            </div>
          )}

          <h2 className="settings-section-title">Permissions</h2>
          <section className="settings-group">
            <div className="settings-row">
              <span className="settings-row-label">Screen Recording</span>
              <span className="settings-row-trailing">
                <span className={`settings-status ${screenRecordingStatus.tone}`}>
                  <span className="settings-status-dot" />
                  {screenRecordingStatus.label}
                </span>
                <button className="settings-button" onClick={() => void handleOpenRecordingSettings()} type="button">
                  Open
                </button>
              </span>
            </div>
          </section>
          <p className="settings-footnote">
            {screenRecordingGranted === false
              ? 'Region capture and screen memory stay unavailable until this is granted. Restart VanillaShot after granting.'
              : 'Needed for region capture and screen memory. Checked without prompting.'}
          </p>

          <h2 className="settings-section-title">Screen Memory</h2>
          <section className="settings-group">
            <div className="settings-row">
              <span className="settings-row-label">Record screen memory</span>
              <button
                className={`settings-switch ${memoryStatus?.recording ? 'on' : ''}`}
                onClick={() => void handleToggleMemoryRecording()}
                type="button"
                role="switch"
                aria-checked={Boolean(memoryStatus?.recording)}
                aria-label="Record screen memory"
                disabled={!desktopRuntime || memoryActionLoading}
              >
                <span className="settings-switch-knob" />
              </button>
            </div>
            <div className="settings-row">
              <span className="settings-row-label">Frame interval</span>
              <span className="settings-row-value">{memoryStatus?.frameIntervalSecs ?? 10} seconds</span>
            </div>
            <div className="settings-row">
              <span className="settings-row-label">Keep recordings for</span>
              <span className="settings-row-value">{memoryStatus?.retentionDays ?? 30} days</span>
            </div>
            <div className="settings-row">
              <span className="settings-row-label">Stored</span>
              <span className="settings-row-value">
                {hasMemoryStats
                  ? `${memoryStatus?.stats?.frameCount ?? 0} frames, ${formatBlobSize(memoryStatus?.stats?.diskUsageBytes ?? 0)}`
                  : 'Nothing yet'}
              </span>
            </div>
          </section>

          <h2 className="settings-section-title">Locations</h2>
          <section className="settings-group">
            <div className="settings-row settings-row-stacked">
              <span className="settings-row-label">
                Screenshots
                <span className="settings-row-path">{captureDir ?? 'Available in the desktop app'}</span>
              </span>
              <button
                className="settings-button"
                onClick={() => void handleRevealPath(captureDir ?? '')}
                type="button"
                disabled={!captureDir}
              >
                Show
              </button>
            </div>
            <div className="settings-row settings-row-stacked">
              <span className="settings-row-label">
                Memory archive
                <span className="settings-row-path">{memoryStatus?.dataDir ?? 'Created on first recording'}</span>
              </span>
              <button
                className="settings-button"
                onClick={() => void handleRevealPath(memoryStatus?.dataDir ?? '')}
                type="button"
                disabled={!memoryStatus?.dataDir}
              >
                Show
              </button>
            </div>
          </section>

          <h2 className="settings-section-title">Capture</h2>
          <section className="settings-group">
            <div className="settings-row">
              <span className="settings-row-label">Capture a region</span>
              <span className="settings-row-trailing">
                <kbd className="settings-kbd">&#8984;&#8679;1</kbd>
                <button className="settings-button" onClick={() => void handleCaptureScreen()} type="button">
                  Capture
                </button>
              </span>
            </div>
            <div className="settings-row">
              <span className="settings-row-label">Edit an existing image</span>
              <button className="settings-button" onClick={handleOpenFilePicker} type="button">
                Choose File
              </button>
            </div>
          </section>

          <h2 className="settings-section-title">About</h2>
          <section className="settings-group">
            <div className="settings-row">
              <span className="settings-row-label">Version</span>
              <span className="settings-row-value">{APP_VERSION_LABEL}</span>
            </div>
            <div className="settings-row">
              <span className="settings-row-label">Author</span>
              <span className="settings-row-value">hack-jitsu.com</span>
            </div>
            <div className="settings-row">
              <span className="settings-row-label">Source</span>
              <button className="settings-button" onClick={() => void handleOpenProjectPage()} type="button">
                GitHub
              </button>
            </div>
          </section>
          <p className="settings-footnote">Capture, OCR and screen memory all run locally. Nothing is uploaded.</p>
        </main>
      )}

      {quickEditorOpen && (
        <main className="workspace workspace-quick">
          <section className="canvas-panel canvas-panel-quick">
            {!baseImage && (
              <div className="placeholder">
                <h2>Load or capture a screenshot</h2>
                <p>Use paste, drag/drop, or capture region.</p>
              </div>
            )}

            {baseImage && (
              <>
                <div className={`canvas-wrap quick-overlay-space ${isSavingAnimation ? 'canvas-fly-out' : ''}`}>
                  <div className="canvas-scale">
                    <canvas
                      ref={canvasRef}
                      onPointerDown={handlePointerDown}
                      onPointerMove={handlePointerMove}
                      onPointerUp={handlePointerUp}
                      onPointerCancel={handlePointerUp}
                      className={`editor-canvas ${activeTool === 'select' ? 'is-selecting' : ''} ${showCrosshair ? 'show-crosshair' : ''}`}
                      style={{
                        width: quickCanvasLogicalWidth,
                        height: quickCanvasLogicalHeight,
                      }}
                    />

                  </div>
                </div>

              </>
            )}
          </section>
        </main>
      )}

      {quickEditorOpen && reportOpen && (
        <div className="report-composer-shell">
          <div className="report-composer" ref={reportComposerRef} role="dialog" aria-label="Add note composer" aria-modal="true">
            <div className="report-composer-head">
              <div className="report-composer-title">
                <span className={`report-title-icon ${reportRecording ? 'active' : ''}`}>
                  <Mic size={15} />
                </span>
                <div className="report-title-copy">
                  <strong>Add note</strong>
                </div>
              </div>
              <div className="report-composer-head-actions">
                <button
                  className={`quick-tool-btn report-help-btn ${reportDetailsOpen ? 'active' : ''}`}
                  onClick={() => setReportDetailsOpen((value) => !value)}
                  type="button"
                  title={reportDetailsOpen ? 'Hide note details' : 'Show note details'}
                  aria-pressed={reportDetailsOpen}
                >
                  <CircleHelp size={14} />
                </button>
                <button className="quick-tool-btn quick-close" onClick={closeReportComposer} type="button" title="Close note composer">
                  <X size={14} />
                </button>
              </div>
            </div>
            <div
              className={`report-inline-status ${
                reportStatus.startsWith('Note failed:') ? 'error' : reportSubmitting ? 'working' : reportRecording ? 'live' : ''
              }`}
            >
              <span className="report-inline-dot" />
              <span>{reportCompactHint}</span>
            </div>
            {reportDetailsOpen && (
              <div className="report-details-panel">
                <div className="report-details-head">
                  <strong>Note details</strong>
                  <span>{NOTE_STORAGE_LABEL}</span>
                </div>
                <div className="report-debug-list" aria-label="Note diagnostics">
                  {reportDebugItems.map((item) => (
                    <div className={`report-debug-row ${item.state.tone}`} key={item.key}>
                      <span className="report-debug-icon">{item.icon}</span>
                      <div className="report-debug-copy">
                        <span className="report-debug-label">{item.label}</span>
                        <span className="report-debug-value">{item.state.detail}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {reportStage === 'recording' ? (
              <>
                <textarea
                  className="report-textarea"
                  value={reportDraft}
                  onChange={(event) => setReportDraft(event.target.value)}
                  placeholder="Write a note to save next to this picture..."
                  rows={6}
                />
                <div className="report-composer-actions">
                  <button className="quick-action quick-report" onClick={() => void handleReportPrimaryEnter()} type="button">
                    <Check size={13} />
                    Review note
                  </button>
                </div>
              </>
            ) : (
              <>
                <pre className="report-preview">{reportCommittedText}</pre>
                <div className="report-composer-actions">
                  <button
                    className="quick-action quick-report"
                    onClick={() => void handleReportApplyNote()}
                    type="button"
                    disabled={reportSubmitting}
                  >
                    <Check size={13} />
                    {reportSubmitting ? 'Attaching...' : 'Use note'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {quickEditorOpen && baseImage && (
        <>
          <div className="quick-toolbar quick-toolbar-top" ref={quickEditorToolbarRef}>
            <div className="quick-bar-group quick-bar-group-annotate">
              <div className="quick-tools">
                {quickAnnotateTools.map((tool) => {
                  const icon = toolButtons.find(([candidate]) => candidate === tool)?.[1]
                  if (!icon) {
                    return null
                  }

                  return (
                    <button
                      key={`quick-annotate-${tool}`}
                      className={`quick-tool-btn ${activeTool === tool ? 'active' : ''}`}
                      onClick={() => setActiveTool(tool)}
                      type="button"
                      title={TOOL_LABEL[tool]}
                    >
                      {icon}
                    </button>
                  )
                })}
              </div>

              <span className="quick-divider" />

              {activeTool === 'arrow' && (
                <div className="quick-choice-row" title="Arrow style">
                  {ARROW_STYLE_OPTIONS.map((style) => (
                    <button
                      key={`quick-arrow-style-${style}`}
                      className={`quick-pill ${arrowStyle === style ? 'active' : ''}`}
                      onClick={() => setArrowStyle(style)}
                      type="button"
                      title={ARROW_STYLE_LABEL[style]}
                    >
                      {style[0].toUpperCase()}
                    </button>
                  ))}
                </div>
              )}

              {activeTool === 'crop' && (
                <div className="quick-choice-row" title="Crop aspect">
                  {CROP_ASPECT_OPTIONS.map((aspect) => (
                    <button
                      key={`quick-crop-aspect-${aspect}`}
                      className={`quick-pill ${cropAspect === aspect ? 'active' : ''}`}
                      onClick={() => setCropAspect(aspect)}
                      type="button"
                      title={`Crop ${aspect}`}
                    >
                      {aspect === 'free' ? 'Free' : aspect}
                    </button>
                  ))}
                  <button className="quick-pill danger" onClick={() => setCropRect(null)} type="button" title="Clear crop">
                    Clear
                  </button>
                </div>
              )}

              {showQuickStrokeControls && (
                <div className="quick-choice-row" title="Stroke width">
                  {STROKE_WIDTH_OPTIONS.map((widthValue) => (
                    <button
                      key={`quick-stroke-width-${widthValue}`}
                      className={`quick-pill ${strokeWidth === widthValue ? 'active' : ''}`}
                      onClick={() => setStrokeWidth(widthValue)}
                      type="button"
                      title={`Stroke ${widthValue}px`}
                    >
                      {widthValue}px
                    </button>
                  ))}
                </div>
              )}

              {showQuickColorControls && (
                <div className="quick-color-palette" title="Color presets">
                  {QUICK_ACCENT_SWATCHES.map((swatch) => (
                    <button
                      key={swatch}
                      className={`quick-swatch ${accentColor.toLowerCase() === swatch.toLowerCase() ? 'active' : ''}`}
                      style={{ '--swatch-color': swatch } as React.CSSProperties}
                      onClick={() => setAccentColor(swatch)}
                      type="button"
                      title={`Color ${swatch}`}
                    />
                  ))}
                  <label className="quick-color" title="Custom color">
                    <input
                      type="color"
                      value={accentColor}
                      onChange={(event) => setAccentColor(event.target.value)}
                    />
                  </label>
                </div>
              )}

              {activeTool === 'text' && (
                <div className="quick-inline-panel quick-inline-panel-text">
                  <div className="quick-inline-panel-head">
                    <strong>Text</strong>
                    <span>{textToolPlacementHint}</span>
                  </div>
                  <div className="quick-inline-panel-row">
                    <input
                      ref={textToolInputRef}
                      className="quick-inline-input"
                      type="text"
                      value={textPromptValue}
                      onChange={(event) => setTextPromptValue(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          event.stopPropagation()
                          handleTextToolSubmit()
                          return
                        }

                        if (event.key === 'Escape') {
                          event.preventDefault()
                          event.stopPropagation()
                          setTextPromptPosition(null)
                          setTextPromptValue('')
                        }
                      }}
                      placeholder="Type text, then click the screenshot"
                    />
                    <button className="quick-action quick-inline-apply" onClick={handleTextToolSubmit} type="button">
                      Add
                    </button>
                  </div>
                </div>
              )}

              <span className="quick-divider" />

              <div className="quick-tools">
                <button
                  className="quick-tool-btn danger-hover"
                  onClick={handleDeleteSelected}
                  disabled={!selectedAnnotationId && activeTool !== 'select'}
                  type="button"
                  title="Delete selected (Backspace)"
                >
                  <Trash2 size={14} />
                </button>
                <button
                  className="quick-tool-btn"
                  onClick={handleUndo}
                  disabled={annotations.length === 0}
                  type="button"
                  title="Undo (Ctrl+Z)"
                >
                  <Undo2 size={14} />
                </button>
              </div>

              <span className="quick-divider" />

              <button
                className={`quick-tool-btn ${showCrosshair ? 'active' : ''}`}
                onClick={() => setShowCrosshair((value) => !value)}
                type="button"
                title="Show crosshair"
              >
                <Crosshair size={14} />
              </button>

              <div className="quick-zoom">
                <button className="quick-tool-btn" onClick={handleZoomOut} type="button" title="Zoom out">
                  <ZoomOut size={14} />
                </button>
                <button className="quick-zoom-value" onClick={handleZoomReset} type="button" title="Reset zoom">
                  {Math.round(zoomLevel * 100)}%
                </button>
                <button className="quick-tool-btn" onClick={handleZoomIn} type="button" title="Zoom in">
                  <ZoomIn size={14} />
                </button>
              </div>
            </div>
          </div>

          <div className="quick-toolbar quick-toolbar-bottom" ref={quickToolbarRef}>
            <div className="quick-bar-group quick-bar-group-capture">
              <button
                className="quick-tool-btn quick-close"
                onClick={dismissQuickEditor}
                type="button"
                title="Close quick editor (Esc)"
              >
                <X size={14} />
              </button>

              <span className="quick-divider" />

              <div className="quick-mode-tools">
                {quickCaptureTools.map((tool) => {
                  const icon = toolButtons.find(([candidate]) => candidate === tool)?.[1]
                  if (!icon) {
                    return null
                  }

                  return (
                    <button
                      key={`quick-${tool}`}
                      className={`quick-tool-chip ${activeTool === tool ? 'active' : ''}`}
                      onClick={() => setActiveTool(tool)}
                      type="button"
                      title={TOOL_LABEL[tool]}
                    >
                      {icon}
                      <span>{TOOL_LABEL[tool]}</span>
                    </button>
                  )
                })}
              </div>
            </div>
            <div className="quick-bar-group quick-bar-group-share">
              <span className="quick-toolbar-meta">{quickShareStatus}</span>
              {showOcrDock && (
                <div className={`quick-inline-panel quick-inline-panel-ocr ${ocrDockPending ? 'pending' : ''}`}>
                  <div className="quick-inline-panel-head">
                    <strong>OCR</strong>
                    <span>
                      {ocrDockPending
                        ? 'Recognizing your selection...'
                        : ocrSelectionResult
                          ? 'Review or copy the extracted text.'
                          : 'Draw a box on the screenshot to extract text.'}
                    </span>
                  </div>
                  <textarea
                    className="quick-inline-textarea"
                    value={ocrDockText}
                    onChange={(event) => {
                      setOcrSelectionResult((current) => {
                        if (!current) {
                          return current
                        }

                        return {
                          ...current,
                          text: event.target.value,
                        }
                      })
                    }}
                    onKeyDown={(event) => event.stopPropagation()}
                    placeholder="OCR text will appear here after you drag a selection."
                    readOnly={!ocrSelectionResult || ocrDockPending}
                    rows={3}
                  />
                  <div className="quick-inline-panel-actions">
                    <button
                      className="button ghost mini"
                      onClick={() => void handleCopyOcrSelectionText()}
                      type="button"
                      disabled={!ocrDockText.trim() || ocrDockPending}
                    >
                      Copy text
                    </button>
                    {ocrSelectionResult && (
                      <button className="button ghost mini" onClick={() => setOcrSelectionResult(null)} type="button">
                        Clear
                      </button>
                    )}
                  </div>
                </div>
              )}
              {(detectedCodes.length > 0 || codeScanError) && (
                <div className="quick-inline-panel quick-inline-panel-codes">
                  <div className="quick-inline-panel-head">
                    <strong>Codes</strong>
                    <span>
                      {codeScanError
                        ? codeScanError
                        : `${detectedCodes.length} decoded${
                            sensitiveCodeCount > 0 ? ` - ${sensitiveCodeCount} worth masking` : ''
                          }`}
                    </span>
                  </div>
                  <ul className="quick-code-list">
                    {detectedCodes.map((code) => {
                      const revealed = code.severity !== 'critical' || revealedCodeIds.includes(code.id)

                      return (
                        <li key={code.id} className={`quick-code-item severity-${code.severity}`}>
                          <div className="quick-code-meta">
                            <span className="quick-code-format">{code.format}</span>
                            <span className="quick-code-severity">{CODE_SEVERITY_LABEL[code.severity]}</span>
                            <span className="quick-code-reason">{code.reason}</span>
                          </div>
                          <p className="quick-code-payload" title={revealed ? code.text : undefined}>
                            {revealed ? truncatePayload(code.text) : 'Hidden - contains secret material'}
                          </p>
                          <div className="quick-code-actions">
                            {code.severity === 'critical' && (
                              <button
                                className="button ghost mini"
                                onClick={() => handleToggleCodeReveal(code.id)}
                                type="button"
                              >
                                {revealed ? 'Hide' : 'Reveal'}
                              </button>
                            )}
                            <button
                              className="button ghost mini"
                              onClick={() => void handleCopyCodeText(code)}
                              type="button"
                            >
                              Copy payload
                            </button>
                            <button className="button ghost mini" onClick={() => maskCodes([code])} type="button">
                              Mask
                            </button>
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                  {sensitiveCodeCount > 0 && (
                    <div className="quick-inline-panel-actions">
                      <button className="button ghost mini" onClick={handleMaskAllSensitiveCodes} type="button">
                        Mask all sensitive ({sensitiveCodeCount})
                      </button>
                    </div>
                  )}
                </div>
              )}
              {sensitiveOcrWords.length > 0 && (
                <button
                  className="quick-action quick-mask"
                  onClick={handleMaskSensitiveWords}
                  type="button"
                  title="Blackout every token OCR flagged as sensitive"
                >
                  <EyeOff size={13} />
                  Mask {sensitiveOcrWords.length}
                </button>
              )}
              <button className="quick-action quick-copy" onClick={() => void handleCopy()} type="button" title="Copy PNG">
                <Copy size={13} />
                Copy
              </button>
              <button className="quick-action quick-save" onClick={() => void handleExport()} type="button" title="Save PNG">
                Save
              </button>
              <button className="quick-action quick-commit" onClick={() => void handleQuickCommit()} type="button" title="Save PNG and copy">
                <Check size={13} />
                Save + Copy
              </button>
              <button
                className={`quick-action quick-memory ${memoryStatus?.recording ? 'active' : ''}`}
                onClick={() => void handleQuickMemoryToggle()}
                type="button"
                title={memoryStatus?.recording ? 'Stop background memory recording' : 'Start background memory recording'}
                disabled={memoryActionLoading || memoryCountdownValue !== null}
              >
                {memoryStatus?.recording ? <Square size={13} /> : <Play size={13} />}
                {quickMemoryActionLabel}
              </button>
              <button
                className={`quick-action quick-report ${(reportOpen || hasAttachedNote) ? 'active' : ''}`}
                onClick={() => void openReportComposer()}
                type="button"
                title="Add note"
              >
                <Mic size={13} />
                Add note
              </button>
            </div>
          </div>
        </>
      )}

      {quickEditorOpen && memoryCountdownValue !== null && (
        <div className="memory-countdown-hud" role="status" aria-live="assertive">
          <span className="memory-countdown-label">Memory recording starts in</span>
          <strong>{memoryCountdownValue}</strong>
          <p>Your screen will start recording locally after the countdown.</p>
        </div>
      )}

      {showCornerMemoryHud && (
        <div className={`memory-corner-hud ${memoryStatus?.recording ? 'live' : 'summary'}`} role="status" aria-live="polite">
          <div className="memory-corner-hud-copy">
            <strong>{cornerMemoryHudPrimaryLabel}</strong>
            <span>{cornerMemoryHudSecondaryLabel}</span>
          </div>
          <div className="memory-corner-hud-actions">
            <button
              className="button ghost mini"
              onClick={() => void handleQuickMemoryToggle()}
              type="button"
              disabled={memoryActionLoading}
            >
              {memoryStatus?.recording ? <Square size={12} /> : <Play size={12} />}
              {memoryActionLoading ? 'Working...' : cornerMemoryHudActionLabel}
            </button>
            {!memoryStatus?.recording && memoryStopSummary && (
              <button
                className="button ghost mini"
                onClick={() => void handleOpenMemoryStopFolder()}
                type="button"
                disabled={memoryActionLoading}
              >
                <FolderOpen size={12} />
                Open
              </button>
            )}
          </div>
        </div>
      )}

      {quickEditorOpen && memoryStatus?.recording && (
        <div className="memory-live-banner" role="status" aria-live="polite">
          <div className="memory-live-banner-copy">
            <strong>{formatElapsedTimer(memoryRecordingElapsedSecs)}</strong>
            <span>{quickMemoryBannerText}</span>
          </div>
          <button className="button ghost mini" onClick={() => void handleQuickMemoryToggle()} type="button">
            <Square size={12} />
            Stop
          </button>
        </div>
      )}

      {quickEditorOpen && (
        <div className="memory-gallery-sidebar" role="complementary" aria-label="Memory gallery">
          <div className="memory-gallery-head">
            <Film size={11} />
            <span>History</span>
          </div>
          <div className="memory-gallery-scroll">
            {galleryThumbs.length === 0 && (
              <p className="memory-gallery-empty">Captured frames will appear here.</p>
            )}
            {galleryThumbs.map((thumb) => (
              <div className="memory-gallery-item" key={`gallery-${thumb.id}`}>
                <img src={thumb.imageDataUrl} alt={`Frame ${thumb.id}`} />
                <span className="memory-gallery-ts">{formatMemoryTimestamp(thumb.timestamp)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {quickEditorOpen && memoryStopSummary && !memoryStatus?.recording && (
        <div className="memory-stop-hud" role="status" aria-live="polite" key={memoryStopSummary.id}>
          <div className="memory-stop-hud-icon">
            <Check size={20} />
          </div>
          <div className="memory-stop-hud-body">
            <strong>Recording stopped ({memoryStopSummary.elapsedLabel})</strong>
            <p>{memoryStopSummary.frameCount} frames &middot; {memoryStopSummary.segmentCount} segments</p>
            <button
              className="memory-stop-hud-path"
              onClick={() => void handleOpenMemoryStopFolder()}
              type="button"
              title="Open folder in Finder"
            >
              <FolderOpen size={12} />
              <span>{memoryStopSummary.dataDir}</span>
            </button>
          </div>
        </div>
      )}

      {quickCommitFx && (
        <button
          className="quick-commit-fx"
          key={quickCommitFx.id}
          onClick={() => void handleOpenQuickCommitPath()}
          type="button"
          title={desktopRuntime ? 'Open folder in Finder' : 'Saved capture'}
        >
          <img src={quickCommitFx.previewUrl} alt="Saved capture preview" />
          <div className="quick-commit-fx-text">
            <p>Saved picture</p>
            {quickCommitFx.noteText.trim() && (
              <p>with "{summarizeMemoryText(quickCommitFx.noteText, 96)}"</p>
            )}
            <code>{quickCommitFx.imagePath}</code>
            {quickCommitFx.notePath && <code>{quickCommitFx.notePath}</code>}
            <p>
              {!desktopRuntime
                ? 'Saved locally.'
                : quickCommitFx.clipboardState === 'copied'
                  ? 'PNG copied to clipboard. Click to open in Finder.'
                  : quickCommitFx.clipboardState === 'failed'
                    ? 'Saved, but copy to clipboard failed. Click to open in Finder.'
                    : 'Click to open in Finder.'}
            </p>
          </div>
        </button>
      )}

      {quickEditorOpen && quickToastMessage && (
        <div
          className={`quick-status-toast ${quickToastTone}`}
          key={`quick-status-${quickToastTone}-${quickToastMessage}`}
          role="status"
          aria-live="polite"
        >
          {quickToastMessage}
        </div>
      )}
    </div>
  )
}

export default App
