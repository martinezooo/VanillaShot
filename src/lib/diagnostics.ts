import { invoke, isTauri } from '@tauri-apps/api/core'

/**
 * Frontend side of the log file.
 *
 * The capture overlay runs with no visible window and no console anyone is
 * going to open, so an exception there is invisible: the overlay just never
 * appears. Everything here routes to the same file the Rust side writes, so one
 * log tells the whole story of a capture.
 */

type Level = 'info' | 'warn' | 'error' | 'debug'

export type DiagnosticsInfo = {
  logPath: string | null
  version: string
  level: string
}

const write = (level: Level, scope: string, message: string) => {
  if (!isTauri()) {
    // Browser preview: the console is right there.
    const line = `[${scope}] ${message}`
    if (level === 'error') console.error(line)
    else if (level === 'warn') console.warn(line)
    else console.log(line)
    return
  }
  // Fire and forget. A logging call must never be the reason a capture fails,
  // so a failed log is swallowed rather than thrown.
  void invoke('log_from_webview', { level, scope, message }).catch(() => {})
}

/** Renders extra values as `key=value`, so a line stays greppable. */
const withFields = (message: string, fields?: Record<string, unknown>): string => {
  if (!fields) {
    return message
  }
  const rendered = Object.entries(fields)
    .map(([key, value]) => `${key}=${typeof value === 'number' ? Math.round(value * 100) / 100 : value}`)
    .join(' ')
  return rendered ? `${message} ${rendered}` : message
}

export const logInfo = (scope: string, message: string, fields?: Record<string, unknown>) =>
  write('info', scope, withFields(message, fields))

export const logWarn = (scope: string, message: string, fields?: Record<string, unknown>) =>
  write('warn', scope, withFields(message, fields))

export const logError = (scope: string, message: string, fields?: Record<string, unknown>) =>
  write('error', scope, withFields(message, fields))

export const logDebug = (scope: string, message: string, fields?: Record<string, unknown>) =>
  write('debug', scope, withFields(message, fields))

/** Turns a caught value into one line, stack included when there is one. */
export const describeError = (error: unknown): string => {
  if (error instanceof Error) {
    return error.stack ? `${error.message} | ${error.stack}` : error.message
  }
  if (typeof error === 'string') {
    return error
  }
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/**
 * Catches what nothing else catches: a thrown exception that escaped a handler,
 * and a rejected promise nobody awaited. Either one can leave the overlay on
 * screen doing nothing, and neither leaves any other trace.
 */
export const installGlobalErrorLogging = (scope: string) => {
  window.addEventListener('error', (event) => {
    const where = event.filename ? ` at ${event.filename}:${event.lineno}:${event.colno}` : ''
    logError(scope, `Uncaught error${where}: ${event.message}`)
  })
  window.addEventListener('unhandledrejection', (event) => {
    logError(scope, `Unhandled rejection: ${describeError(event.reason)}`)
  })
}

export const getDiagnosticsInfo = async (): Promise<DiagnosticsInfo | null> => {
  if (!isTauri()) {
    return null
  }
  try {
    return await invoke<DiagnosticsInfo>('diagnostics_info')
  } catch {
    return null
  }
}

export const readRecentLog = async (lines = 300): Promise<string> => {
  if (!isTauri()) {
    return ''
  }
  return invoke<string>('diagnostics_read_log', { lines })
}
