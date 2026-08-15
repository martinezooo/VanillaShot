import { findEmbeddedSensitiveReason } from './sensitive'

export type CodeSeverity = 'critical' | 'sensitive' | 'benign'

export type CodeClassification = {
  severity: CodeSeverity
  /** Human-readable justification, shown next to the payload. */
  reason: string
}

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
  const text = rawText.trim()
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
  const text = rawText.trim()
  if (!text) {
    return { severity: 'benign', reason: 'empty payload' }
  }

  const lower = text.toLowerCase()

  for (const { prefix, reason } of CRITICAL_PREFIXES) {
    if (lower.startsWith(prefix)) {
      return { severity: 'critical', reason }
    }
  }

  if (/-----begin [a-z ]*private key-----/i.test(text)) {
    return { severity: 'critical', reason: 'private key material' }
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

  return { severity: 'benign', reason: 'plain text' }
}
