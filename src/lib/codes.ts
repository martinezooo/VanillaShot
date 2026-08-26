import { prepareZXingModule, readBarcodes, type ReadResult } from 'zxing-wasm/reader'
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url'

import { classifyCodePayload, parseHttpUrl, type CodeSeverity } from './codeClassification'

export type { CodeSeverity }

export type CodeRect = {
  x: number
  y: number
  width: number
  height: number
}

export type DetectedCode = {
  id: string
  text: string
  format: string
  rect: CodeRect
  severity: CodeSeverity
  /** Human-readable justification for the severity, shown next to the payload. */
  reason: string
  /** Set only for payloads that resolve to an http(s) URL. Never opened automatically. */
  url: string | null
}

// Screenshots from a pentest carry 2D codes far more often than retail linear
// ones, but Code 128 / EAN show up in logistics and inventory tooling.
const SCAN_FORMATS = [
  'QRCode',
  'MicroQRCode',
  'RMQRCode',
  'DataMatrix',
  'Aztec',
  'PDF417',
  'Code128',
  'Code39',
  'EAN13',
  'ITF',
] as const

const MAX_SYMBOLS = 16

/**
 * Padding added around the decoded quiet zone when a code is masked. ZXing
 * reports the finder-pattern corners, which sit inside the printed module grid;
 * without the margin a blackout leaves a readable border of the symbol behind.
 */
const MASK_PADDING_RATIO = 0.08

let moduleConfigured = false

// zxing-wasm defaults to fetching its WASM binary from the jsDelivr CDN.
// VanillaShot is local-first and runs offline, so Vite bundles it instead.
const configureModule = (): void => {
  if (moduleConfigured) {
    return
  }

  prepareZXingModule({
    overrides: {
      locateFile: (path: string, prefix: string) =>
        path.endsWith('.wasm') ? wasmUrl : `${prefix}${path}`,
    },
  })

  moduleConfigured = true
}

const toRect = (result: ReadResult): CodeRect | null => {
  const { topLeft, topRight, bottomLeft, bottomRight } = result.position
  const xs = [topLeft.x, topRight.x, bottomLeft.x, bottomRight.x]
  const ys = [topLeft.y, topRight.y, bottomLeft.y, bottomRight.y]

  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  const width = Math.max(...xs) - minX
  const height = Math.max(...ys) - minY

  if (!Number.isFinite(minX) || !Number.isFinite(minY) || width <= 0 || height <= 0) {
    return null
  }

  const padX = width * MASK_PADDING_RATIO
  const padY = height * MASK_PADDING_RATIO

  return {
    x: minX - padX,
    y: minY - padY,
    width: width + padX * 2,
    height: height + padY * 2,
  }
}

/**
 * Pixel budget handed to the decoder.
 *
 * zxing runs synchronously on the main thread, and `tryHarder`, `tryRotate` and
 * `tryInvert` each multiply the work. At full retina resolution that already
 * costs a noticeable pause, and an image whose dimensions someone else chose
 * can freeze the editor for seconds. 12MP covers a retina full-screen capture
 * with room to spare, and codes stay legible after downscaling because a symbol
 * worth decoding is far larger than one pixel per module.
 */
const MAX_SCAN_PIXELS = 12_000_000

type ScanSource = { imageData: ImageData; scale: number }

const toImageData = (image: HTMLImageElement): ScanSource | null => {
  const naturalWidth = image.naturalWidth
  const naturalHeight = image.naturalHeight
  if (naturalWidth === 0 || naturalHeight === 0) {
    return null
  }

  const pixels = naturalWidth * naturalHeight
  const scale = pixels > MAX_SCAN_PIXELS ? Math.sqrt(MAX_SCAN_PIXELS / pixels) : 1

  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(naturalWidth * scale))
  canvas.height = Math.max(1, Math.round(naturalHeight * scale))

  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) {
    return null
  }

  context.drawImage(image, 0, 0, canvas.width, canvas.height)

  return { imageData: context.getImageData(0, 0, canvas.width, canvas.height), scale }
}

/**
 * Decodes every QR / 2D / linear code in the image. Coordinates are returned in
 * natural image pixels, matching the OCR word boxes.
 */
export const scanCodesFromImage = async (image: HTMLImageElement): Promise<DetectedCode[]> => {
  const source = toImageData(image)
  if (!source) {
    return []
  }

  const { imageData, scale } = source

  configureModule()

  const results = await readBarcodes(imageData, {
    formats: [...SCAN_FORMATS],
    tryHarder: true,
    tryRotate: true,
    tryInvert: true,
    maxNumberOfSymbols: MAX_SYMBOLS,
  })

  const codes: DetectedCode[] = []

  results.forEach((result, index) => {
    if (!result.isValid || !result.text) {
      return
    }

    const scanRect = toRect(result)
    if (!scanRect) {
      return
    }

    // Coordinates come back in the (possibly downscaled) scan space, so undo the
    // scale before they are used as mask rectangles over the full-size image.
    const rect =
      scale === 1
        ? scanRect
        : {
            x: Math.round(scanRect.x / scale),
            y: Math.round(scanRect.y / scale),
            width: Math.round(scanRect.width / scale),
            height: Math.round(scanRect.height / scale),
          }

    const { severity, reason } = classifyCodePayload(result.text)
    const url = parseHttpUrl(result.text)

    codes.push({
      id: `code-${index}-${rect.x}-${rect.y}`,
      text: result.text,
      format: result.format,
      rect,
      severity,
      reason,
      url: url ? url.toString() : null,
    })
  })

  return codes
}
