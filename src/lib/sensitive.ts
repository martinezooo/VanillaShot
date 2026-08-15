const SENSITIVE_PATTERNS: RegExp[] = [
  /^(?:\d{1,3}\.){3}\d{1,3}$/, // IPv4
  /^[A-F0-9:]{4,}$/i, // IPv6-ish chunks
  /^[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}$/, // email
  /^https?:\/\/.+$/i, // URL
  /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, // JWT
  /^(?:AKIA|ASIA)[A-Z0-9]{16}$/, // AWS access key
  /^[A-Fa-f0-9]{32,}$/, // hashes
]

export const isSensitiveToken = (rawText: string): boolean => {
  const token = rawText.trim()
  if (!token) {
    return false
  }

  if (SENSITIVE_PATTERNS.some((pattern) => pattern.test(token))) {
    return true
  }

  // Catches random-looking API keys that do not match a known prefix.
  const hasLetters = /[A-Za-z]/.test(token)
  const hasNumbers = /\d/.test(token)
  const likelyToken = hasLetters && hasNumbers && token.length >= 24 && /^[A-Za-z0-9._-]+$/.test(token)

  return likelyToken
}

// Same detectors as above, but applied anywhere inside a longer string. Barcode
// payloads are whole documents rather than single OCR words, so an anchored
// match would miss a token embedded in a query string.
// Order matters: the first match wins, so credential-grade detectors are listed
// before the weaker shape-based ones. Otherwise `?token=<hex>` reads as a plain
// hash instead of the credential it is.
const EMBEDDED_SENSITIVE_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/, reason: 'JWT token' },
  { pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/, reason: 'AWS access key' },
  {
    pattern: /(?:token|secret|api[_-]?key|password|passwd|pwd|session|auth|sig|signature)=[^&\s]{8,}/i,
    reason: 'credential in query string',
  },
  { pattern: /\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/, reason: 'email address' },
  { pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/, reason: 'IPv4 address' },
  { pattern: /\b[A-Fa-f0-9]{32,}\b/, reason: 'hash-like hex value' },
]

export const findEmbeddedSensitiveReason = (rawText: string): string | null => {
  const text = rawText.trim()
  if (!text) {
    return null
  }

  for (const { pattern, reason } of EMBEDDED_SENSITIVE_PATTERNS) {
    if (pattern.test(text)) {
      return reason
    }
  }

  return null
}
