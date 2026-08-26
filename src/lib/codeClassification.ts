import { findEmbeddedSensitiveReason } from './sensitive'

export type CodeSeverity = 'critical' | 'sensitive' | 'benign'

export type CodeClassification = {
  severity: CodeSeverity
  /** Human-readable justification, shown next to the payload. */
  reason: string
}

/**
 * Strips characters that are invisible on screen but still count as content,
 * so a payload cannot dodge classification by hiding behind them.
 *
 * `String.trim` removes whitespace but leaves Unicode format characters (Cf)
 * alone, so a single zero-width space in front of `otpauth://` was enough to
 * make a 2FA seed classify as plain text. It then skipped the reveal gate and
 * was left out of "Mask all sensitive".
 *
 * Only classification uses this. The payload shown and copied stays byte-exact.
 */
export const normalizeForClassification = (rawText: string): string =>
  rawText
    // C0 and C1 controls, zero-width and bidi format characters, BOM.
    // Matching control characters is the whole point here.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, '')
    .trim()

const CRITICAL_PREFIXES: { prefix: string; reason: string }[] = [
  { prefix: 'otpauth://', reason: 'TOTP/HOTP seed - grants ongoing 2FA access' },
  { prefix: 'otpauth-migration://', reason: 'Authenticator export - multiple 2FA seeds' },
  { prefix: 'wifi:', reason: 'Wi-Fi network credentials' },
]

const SENSITIVE_PREFIXES: { prefix: string; reason: string }[] = [
  { prefix: 'mailto:', reason: 'email address' },
  { prefix: 'tel:', reason: 'phone number' },
  { prefix: 'smsto:', reason: 'phone number' },
  { prefix: 'sms:', reason: 'phone number' },
  { prefix: 'begin:vcard', reason: 'contact card' },
  { prefix: 'ssh://', reason: 'SSH target' },
  { prefix: 'smb://', reason: 'SMB share' },
  { prefix: 'ftp://', reason: 'FTP target' },
]

export const parseHttpUrl = (rawText: string): URL | null => {
  const text = normalizeForClassification(rawText)
  if (!/^https?:\/\//i.test(text)) {
    return null
  }

  try {
    return new URL(text)
  } catch {
    return null
  }
}

export const classifyCodePayload = (rawText: string): CodeClassification => {
  const text = normalizeForClassification(rawText)
  if (!text) {
    return { severity: 'benign', reason: 'empty payload' }
  }

  const lower = text.toLowerCase()

  for (const { prefix, reason } of CRITICAL_PREFIXES) {
    if (lower.startsWith(prefix)) {
      return { severity: 'critical', reason }
    }
  }

  // PGP armor ends in " BLOCK", which the narrower pattern missed, so a paper
  // backup of a private key was classified as plain text and skipped by
  // "Mask all sensitive".
  if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/i.test(text)) {
    return { severity: 'critical', reason: 'private key material' }
  }

  // Any other armored block is worth a second look even if we cannot name it.
  if (/-----BEGIN [A-Z0-9 ]+-----/i.test(text)) {
    return { severity: 'sensitive', reason: 'armored key or certificate block' }
  }

  const url = parseHttpUrl(text)
  if (url && (url.username || url.password)) {
    return { severity: 'critical', reason: 'URL with embedded credentials' }
  }

  const embedded = findEmbeddedSensitiveReason(text)
  if (embedded) {
    // A credential inside a link is still a credential - treat it as critical
    // rather than as a plain link.
    const critical = /JWT|AWS|credential/i.test(embedded)
    return { severity: critical ? 'critical' : 'sensitive', reason: embedded }
  }

  if (url) {
    return { severity: 'sensitive', reason: 'link - may be session-scoped' }
  }

  for (const { prefix, reason } of SENSITIVE_PREFIXES) {
    if (lower.startsWith(prefix)) {
      return { severity: 'sensitive', reason }
    }
  }

  // Anything that looks like a URI but matched no table above is still a
  // pointer at something, and unknown schemes (file:, data:, vendor schemes
  // carrying session tokens) should not be quietly dropped from
  // "Mask all sensitive".
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(text)
  if (scheme && !/^https?$/i.test(scheme[1])) {
    return { severity: 'sensitive', reason: `${scheme[1].toLowerCase()} link` }
  }

  return { severity: 'benign', reason: 'plain text' }
}
