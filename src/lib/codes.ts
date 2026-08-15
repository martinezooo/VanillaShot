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

// zxing-wasm defaults to fetching its WASM binary from the jsDelivr CDN. AYE is
// local-first and runs offline, so the binary is bundled by Vite instead.
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

const toImageData = (image: HTMLImageElement): ImageData | null => {
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight

  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context || canvas.width === 0 || canvas.height === 0) {
    return null
  }

  context.drawImage(image, 0, 0)

  return context.getImageData(0, 0, canvas.width, canvas.height)
}

/**
 * Decodes every QR / 2D / linear code in the image. Coordinates are returned in
 * natural image pixels, matching the OCR word boxes.
 */
export const scanCodesFromImage = async (image: HTMLImageElement): Promise<DetectedCode[]> => {
  const imageData = toImageData(image)
  if (!imageData) {
    return []
  }

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

    const rect = toRect(result)
    if (!rect) {
      return
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
