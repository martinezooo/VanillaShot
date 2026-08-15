import { invoke, isTauri } from '@tauri-apps/api/core'

export type MemoryStats = {
  segmentCount: number
  frameCount: number
  diskUsageBytes: number
  oldestFrame?: string | null
  newestFrame?: string | null
}

export type MemoryStatus = {
  recording: boolean
  recordingStartedAt?: string | null
  stats?: MemoryStats | null
  dataDir: string
  segmentDurationSecs: number
  frameIntervalSecs: number
  retentionDays: number
}

export type MemoryFrame = {
  id: number
  segmentId: number
  timestamp: string
  offsetSecs: number
  framePath: string
  ocrText: string
}

export type MemorySegment = {
  id: number
  startTime: string
  endTime?: string | null
  videoPath: string
  durationSecs?: number | null
}

export type MemoryFrameWithImage = MemoryFrame & {
  imageDataUrl: string
  segment?: MemorySegment | null
}

type MemoryErrorPayload = {
  message?: string
}

export class MemoryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MemoryError'
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

const normalizeMemoryError = (error: unknown): MemoryError => {
  if (typeof error === 'string') {
    try {
      const parsed = JSON.parse(error) as MemoryErrorPayload
      if (typeof parsed?.message === 'string' && parsed.message.trim().length > 0) {
        return new MemoryError(parsed.message)
      }
    } catch {
      return new MemoryError(error)
    }

    return new MemoryError(error)
  }

  if (error instanceof Error) {
    return new MemoryError(error.message)
  }

  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as MemoryErrorPayload).message
    if (typeof message === 'string' && message.trim().length > 0) {
      return new MemoryError(message)
    }
  }

  return new MemoryError('Memory request failed')
}

const ensureDesktopRuntime = (): void => {
  if (!isDesktopRuntime()) {
    throw new MemoryError('Memory features are available only in the desktop app')
  }
}

const invokeMemory = async <T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> => {
  ensureDesktopRuntime()

  try {
    return await invoke<T>(command, args)
  } catch (error) {
    throw normalizeMemoryError(error)
  }
}

export const getMemoryStatus = async (): Promise<MemoryStatus> => invokeMemory('memory_status')

export const openMemoryPathInFinder = async (path: string): Promise<string> =>
  invokeMemory('memory_open_path_in_finder', { path })

export const startMemoryRecording = async (): Promise<string> => invokeMemory('memory_start')

export const stopMemoryRecording = async (): Promise<string> => invokeMemory('memory_stop')

export const searchMemory = async (query: string, limit = 20): Promise<MemoryFrame[]> =>
  invokeMemory('memory_search', { query, limit })

export const getMemoryTimeline = async (
  start: string,
  end: string,
  limit = 20,
): Promise<MemoryFrame[]> => invokeMemory('memory_get_timeline', { start, end, limit })

export const getMemoryFrame = async (id: number): Promise<MemoryFrameWithImage | null> =>
  invokeMemory('memory_get_frame', { id })
