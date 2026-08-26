/**
 * Secret and PII detection for OCR words and decoded code payloads.
 *
 * Tokens arrive in three shapes and the detectors have to cope with all of them:
 *
 *   - bare values from OCR:        AKIAIOSFODNN7EXAMPLE
 *   - KEY=VALUE / KEY: VALUE lines: AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
 *   - values wrapped in syntax:    "eyJhbGciOi...",   'hunter2'   <token>
 *
 * OCR also splits lines into words, so "Authorization: Bearer eyJ..." reaches
 * us as three tokens. `flagLineTokens` restores that context.
 */

/** Characters that wrap a value without being part of it. */
const WRAPPING = /^[\s"'`<>[\](){},]+|[\s"'`<>[\](){},]+$/g

const stripWrapping = (raw: string): string => raw.replace(WRAPPING, '')

/** Splits KEY=VALUE / KEY: VALUE into its parts; returns null when there is no separator. */
const splitAssignment = (token: string): { key: string; value: string } | null => {
  // KEY=VALUE, or header-style "Key: value" (colon then whitespace). A bare
  // colon is not a separator, so host:port and a:b:c::: stay whole and match
  // TOKEN_PATTERNS instead.
  const match = /^([A-Za-z_][\w.-]{0,63})(?:\s*=\s*|:\s+)(.+)$/.exec(token)
  return match ? { key: match[1], value: match[2] } : null
}

/** Names whose value is a secret regardless of what the value looks like. */
const SECRET_KEY_NAME =
  /(?:^|[_.-])(?:pass(?:word|wd|phrase)?|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|auth|authorization|bearer|cookie|session(?:[_-]?id)?|credential|client[_-]?secret|signing[_-]?key|otp|totp|seed|mnemonic)(?:$|[_.-])/i

/**
 * Anchored detectors for a whole token. Ordered so that the specific, low
 * false-positive shapes come first.
 */
const TOKEN_PATTERNS: { pattern: RegExp; reason: string }[] = [
  // Cloud and SaaS credential prefixes
  { pattern: /^(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[A-Z0-9]{16}$/, reason: 'AWS access key' },
  { pattern: /^(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}$/, reason: 'GitHub token' },
  { pattern: /^github_pat_[A-Za-z0-9_]{22,}$/, reason: 'GitHub fine-grained token' },
  { pattern: /^glpat-[A-Za-z0-9_-]{20,}$/, reason: 'GitLab token' },
  { pattern: /^xox[abpors]-[A-Za-z0-9-]{10,}$/, reason: 'Slack token' },
  { pattern: /^(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}$/, reason: 'Stripe key' },
  { pattern: /^sk-[A-Za-z0-9_-]{20,}$/, reason: 'API secret key' },
  { pattern: /^AIza[A-Za-z0-9_-]{35,40}$/, reason: 'Google API key' },
  { pattern: /^ya29\.[A-Za-z0-9_-]{30,}$/, reason: 'Google OAuth token' },
  { pattern: /^SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}$/, reason: 'SendGrid key' },
  { pattern: /^(?:hooks\.slack\.com\/services\/|discord(?:app)?\.com\/api\/webhooks\/)/i, reason: 'webhook URL' },
  { pattern: /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*$/, reason: 'JWT' },
  { pattern: /^v[1-4]\.(?:local|public)\.[A-Za-z0-9_-]{20,}$/, reason: 'PASETO token' },
  { pattern: /^-----BEGIN\b/, reason: 'PEM block' },

  // Password hashes as they appear in dumps
  { pattern: /^\$(?:2[abxy]|argon2(?:id|i|d)?|scrypt|pbkdf2[^$]*|y|gy|[156]|sha1|md5|apr1)\$[^\s]{10,}$/i, reason: 'password hash' },
  { pattern: /^\{(?:SSHA|SHA|MD5|CRYPT|SMD5)\}[A-Za-z0-9+/=]{16,}$/i, reason: 'LDAP password hash' },
  { pattern: /^[A-Fa-f0-9]{32}:[A-Fa-f0-9]{32}$/, reason: 'LM:NT hash pair' },
  { pattern: /^[^\s:]+:\d+:[A-Fa-f0-9]{32}:[A-Fa-f0-9]{32}:::$/, reason: 'secretsdump hash line' },
  { pattern: /^\$?(?:krb5|NTLMv?2?|netntlmv?2?)[^\s]{20,}$/i, reason: 'Kerberos/NTLM material' },

  // Network identity
  { pattern: /^(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?$/, reason: 'IPv4 address' },
  { pattern: /^(?:[A-Fa-f0-9]{1,4}:){3,7}(?:[A-Fa-f0-9]{1,4}|:)(?:\/\d{1,3})?$|^(?=[0-9A-Fa-f:]*[A-Fa-f])(?:[A-Fa-f0-9]{1,4}:){2,7}[A-Fa-f0-9]{1,4}$/, reason: 'IPv6 address' },
  { pattern: /^(?:[A-Fa-f0-9]{2}[:-]){5}[A-Fa-f0-9]{2}$/, reason: 'MAC address' },
  { pattern: /^[\w.+-]+@[\w-]+(?:\.[\w-]+)+$/, reason: 'email address' },
  { pattern: /^(?:https?|ftp|sftp|ssh|smb|rdp|vnc|ldaps?|jdbc:[a-z]+|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/\S+$/i, reason: 'URL' },

  // Hex digests and long hex
  { pattern: /^[A-Fa-f0-9]{32}$|^[A-Fa-f0-9]{40}$|^[A-Fa-f0-9]{64}$|^[A-Fa-f0-9]{128}$/, reason: 'hash digest' },
]

/**
 * Words a pentest screenshot is full of that look like tokens but are not.
 * Checked before the entropy heuristic so it does not blacklist a whole
 * screenshot of filenames and versions.
 */
const BENIGN_SHAPES: RegExp[] = [
  /^v?\d+(?:\.\d+){1,3}(?:[-+][\w.]+)?$/, // versions: 1.2.3, v2.0.1-beta
  /^[\w-]+\.(?:png|jpe?g|gif|svg|pdf|txt|md|json|ya?ml|toml|xml|csv|log|zip|tar|gz|dmg|pkg|app|exe|dll|so|dylib|py|js|ts|tsx|rs|go|rb|sh|html?|css)$/i,
  /^\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?$/, // clock times
  /^\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?$/, // dates
  /^\d+$/, // plain numbers
  /^[A-Z][a-z]+(?:[A-Z][a-z]+)+$/, // PascalCase identifiers
  /^[a-z]+(?:[A-Z][a-z]+)+$/, // camelCase identifiers
  /^[A-Z_]{3,}$/, // ENV_STYLE constants without digits
  /^[\w-]+(?:\.[\w-]+)+$/, // hostnames and dotted identifiers
  /^0x[A-Fa-f0-9]{1,16}$/, // short hex literals, pointers
]

/**
 * Random-looking strings that match no known prefix: API keys, session ids,
 * signing secrets. Needs both letter cases and digits, no separators that
 * would suggest a word, and enough length that an identifier is unlikely.
 */
const looksLikeOpaqueSecret = (token: string): boolean => {
  if (token.length < 20 || token.length > 512) {
    return false
  }

  if (!/^[A-Za-z0-9+/=_.-]+$/.test(token)) {
    return false
  }

  const upper = /[A-Z]/.test(token)
  const lower = /[a-z]/.test(token)
  const digits = (token.match(/\d/g) ?? []).length
  const letters = (token.match(/[A-Za-z]/g) ?? []).length

  // Base64-ish blobs (padding, or long with + and /) count even without digits.
  const base64ish = token.length >= 40 && /[+/]/.test(token) && /=*$/.test(token)
  if (base64ish && letters > 0) {
    return true
  }

  return upper && lower && digits >= 2 && letters >= 8
}

/**
 * Short strings that read as a password on their own: mixed case, a digit, and
 * a punctuation mark, of the length people actually use. Kept separate from the
 * opaque-secret rule so its punctuation does not widen that one.
 */
const looksLikePassword = (token: string): boolean => {
  if (token.length < 8 || token.length > 64 || /\s/.test(token)) {
    return false
  }

  const classes =
    Number(/[a-z]/.test(token)) +
    Number(/[A-Z]/.test(token)) +
    Number(/\d/.test(token)) +
    Number(/[^A-Za-z0-9]/.test(token))

  // Shell prompts and paths carry symbols too. A password does not contain
  // path/prompt punctuation.
  if (/[/~$@\\]|:~|:\s*$|\$\s*$/.test(token)) {
    return false
  }

  // Require a symbol plus at least three character classes, so ordinary words
  // and identifiers (which have no symbol) are left alone.
  return classes >= 3 && /[^A-Za-z0-9]/.test(token)
}

export type SensitiveMatch = { reason: string }

/** Classifies a single token. Exposed for tests and for the QR classifier. */
export const classifyToken = (rawText: string): SensitiveMatch | null => {
  const token = stripWrapping(rawText)
  if (!token) {
    return null
  }

  // Whole-token patterns first: structured lines (secretsdump, LM:NT pairs,
  // scheme://... URLs) must not be torn apart by the assignment splitter.
  for (const { pattern, reason } of TOKEN_PATTERNS) {
    if (pattern.test(token)) {
      return { reason }
    }
  }

  const assignment = splitAssignment(token)
  if (assignment) {
    const value = stripWrapping(assignment.value)
    if (SECRET_KEY_NAME.test(assignment.key) && value.length >= 4) {
      return { reason: `${assignment.key} assignment` }
    }

    const inner = value ? classifyToken(value) : null
    if (inner) {
      return inner
    }
  }

  if (BENIGN_SHAPES.some((pattern) => pattern.test(token))) {
    return null
  }

  if (looksLikeOpaqueSecret(token)) {
    return { reason: 'high-entropy token' }
  }

  if (looksLikePassword(token)) {
    return { reason: 'likely password' }
  }

  return null
}

export const isSensitiveToken = (rawText: string): boolean => classifyToken(rawText) !== null

/**
 * Keywords that mark the token(s) after them as secret: "Bearer xyz",
 * "password: hunter2", "Authorization: Basic dXNlcjpwYXNz".
 */
const CONTEXT_KEYWORDS = /^(?:bearer|basic|digest|ntlm|negotiate|password|passwd|pwd|pass|secret|token|api[_-]?key|apikey|authorization|auth|cookie|set-cookie|x-api-key|x-auth-token|session|otp|pin)[:=]?$/i

/**
 * Flags every token of an OCR line, using the neighbours for context so
 * "Bearer <token>" and "password: hunter2" are caught even when the value on
 * its own looks ordinary.
 */
export const flagLineTokens = (tokens: string[]): boolean[] => {
  const flags = tokens.map((token) => isSensitiveToken(token))

  for (let index = 0; index < tokens.length; index += 1) {
    const token = stripWrapping(tokens[index])
    if (!CONTEXT_KEYWORDS.test(token)) {
      continue
    }

    // The keyword may carry its separator ("password:") or the next token may
    // be the separator itself ("password", ":", "hunter2").
    let next = index + 1
    if (next < tokens.length && /^[:=]$/.test(tokens[next].trim())) {
      next += 1
    }

    if (next < tokens.length && stripWrapping(tokens[next]).length >= 3) {
      flags[next] = true
    }
  }

  return flags
}

/** Detectors applied anywhere inside a longer string, for QR payloads. */
const EMBEDDED_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, reason: 'private key material' },
  { pattern: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/, reason: 'JWT token' },
  { pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/, reason: 'AWS access key' },
  { pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/, reason: 'GitHub token' },
  { pattern: /\bxox[abpors]-[A-Za-z0-9-]{10,}\b/, reason: 'Slack token' },
  { pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/, reason: 'Stripe secret key' },
  { pattern: /\bAIza[A-Za-z0-9_-]{35}\b/, reason: 'Google API key' },
  {
    // Left boundary keeps `oauth=`/`xsig=` from matching as `auth=`/`sig=`.
    pattern:
      /(?:^|[?&#;\s])(?:token|secret|api[_-]?key|password|passwd|pwd|session|sessionid|auth|sig|signature|access_token|refresh_token|private_key|privatekey)\s*[=:]\s*[^&\s]{8,}/i,
    reason: 'credential in query string',
  },
  { pattern: /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/, reason: 'email address' },
  { pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/, reason: 'IPv4 address' },
  { pattern: /\b[A-Fa-f0-9]{32,}\b/, reason: 'hash-like hex value' },
]

export const findEmbeddedSensitiveReason = (rawText: string): string | null => {
  const text = rawText.trim()
  if (!text) {
    return null
  }

  for (const { pattern, reason } of EMBEDDED_PATTERNS) {
    if (pattern.test(text)) {
      return reason
    }
  }

  return null
}
