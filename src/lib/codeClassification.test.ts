import { describe, expect, it } from 'vitest'

import {
  classifyCodePayload,
  normalizeForClassification,
  parseHttpUrl,
} from './codeClassification'

describe('normalizeForClassification', () => {
  it('removes control and invisible formatting characters', () => {
    expect(normalizeForClassification('\u200b\u202eotpauth://totp/example\u0000')).toBe(
      'otpauth://totp/example',
    )
  })
})

describe('classifyCodePayload', () => {
  it.each(['\u200botpauth://totp/example?secret=ABC', '\u2066wifi:S:Office;P:secret;;']) (
    'does not let invisible characters hide a critical payload: %s',
    (payload) => {
      expect(classifyCodePayload(payload).severity).toBe('critical')
    },
  )

  it('recognizes an armored PGP private key block as critical', () => {
    expect(classifyCodePayload('-----BEGIN PGP PRIVATE KEY BLOCK-----\nsecret').severity).toBe(
      'critical',
    )
  })

  it('treats other armored blocks as sensitive', () => {
    expect(classifyCodePayload('-----BEGIN CERTIFICATE-----\ndata').severity).toBe('sensitive')
  })

  it.each(['file:///etc/passwd', 'data:text/plain,secret', 'vendor-app:session-token']) (
    'treats an unknown or local URI scheme as sensitive: %s',
    (payload) => {
      expect(classifyCodePayload(payload).severity).toBe('sensitive')
    },
  )

  it('keeps ordinary text benign', () => {
    expect(classifyCodePayload('inventory item 1042')).toEqual({
      severity: 'benign',
      reason: 'plain text',
    })
  })
})

describe('parseHttpUrl', () => {
  it('normalizes invisible characters before parsing', () => {
    expect(parseHttpUrl('\u200bhttps://example.com/path')?.toString()).toBe(
      'https://example.com/path',
    )
  })

  it('rejects non-http schemes', () => {
    expect(parseHttpUrl('file:///tmp/capture.png')).toBeNull()
  })
})
