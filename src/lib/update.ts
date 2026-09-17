import { isTauri } from '@tauri-apps/api/core'
import { check, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { logError, logInfo, describeError } from './diagnostics'

/**
 * One-click update.
 *
 * This is the only code in the app that touches the network, and it runs only
 * when the user presses the button. There is no check on a timer, none at
 * launch, and nothing is sent out: the request asks GitHub for a file and the
 * reply is a version number and a download link.
 *
 * The downloaded archive carries a signature made with a key that never leaves
 * the maintainer's machine. The plugin refuses anything that does not verify
 * against the public key compiled into the app, so a tampered or substituted
 * download cannot install.
 */

export type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'current' }
  | { kind: 'available'; version: string; notes: string | null }
  | { kind: 'downloading'; version: string; received: number; total: number | null }
  | { kind: 'ready'; version: string }
  | { kind: 'error'; message: string }

let pending: Update | null = null

/** Asks whether a newer release exists. Returns what to show. */
export const checkForUpdate = async (): Promise<UpdateState> => {
  if (!isTauri()) {
    return { kind: 'error', message: 'Updating works in the desktop app only.' }
  }
  try {
    logInfo('update', 'Checking for a new version')
    const update = await check()
    if (!update) {
      logInfo('update', 'Already on the newest version')
      pending = null
      return { kind: 'current' }
    }
    logInfo('update', `Update available: ${update.version}`)
    pending = update
    return { kind: 'available', version: update.version, notes: update.body ?? null }
  } catch (error) {
    // Offline, GitHub unreachable, or a manifest that does not parse. None of
    // these should look like a broken app, so the message says what happened.
    logError('update', `Check failed: ${describeError(error)}`)
    pending = null
    return { kind: 'error', message: describeError(error) }
  }
}

/**
 * Downloads and installs the update found by the last check, reporting
 * progress. The caller decides when to relaunch.
 */
export const installUpdate = async (
  onProgress: (received: number, total: number | null) => void,
): Promise<UpdateState> => {
  if (!pending) {
    return { kind: 'error', message: 'Check for an update first.' }
  }
  const update = pending
  try {
    let received = 0
    let total: number | null = null
    await update.downloadAndInstall((event) => {
      if (event.event === 'Started') {
        total = event.data.contentLength ?? null
        logInfo('update', `Downloading ${update.version}`, { bytes: total ?? 'unknown' })
      } else if (event.event === 'Progress') {
        received += event.data.chunkLength
        onProgress(received, total)
      } else if (event.event === 'Finished') {
        logInfo('update', 'Download finished, installing')
      }
    })
    logInfo('update', `Installed ${update.version}, waiting for relaunch`)
    pending = null
    return { kind: 'ready', version: update.version }
  } catch (error) {
    logError('update', `Install failed: ${describeError(error)}`)
    return { kind: 'error', message: describeError(error) }
  }
}

/** Restarts into the version just installed. */
export const relaunchApp = async (): Promise<void> => {
  logInfo('update', 'Relaunching')
  await relaunch()
}

/** Bytes as something readable next to a progress bar. */
export const formatBytes = (value: number): string => {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}
