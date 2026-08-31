import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockVerify = vi.fn()

vi.mock('@solid/access-token-verifier', () => ({
  default: {
    createSolidTokenVerifier: () => mockVerify
  }
}))

const ALLOWED = ['https://alice.example/webid#me']
const URL = 'https://api.example/foo/bar'

async function importAuth() {
  return import('../../src/auth.js')
}

beforeEach(() => {
  mockVerify.mockReset()
})

describe('verifyDpopToken', () => {
  it('returns 401 when Authorization header is missing', async () => {
    const { verifyDpopToken } = await importAuth()
    const result = await verifyDpopToken(undefined, 'dpop', URL, 'PUT', ALLOWED)
    expect(result).toEqual({
      success: false,
      statusCode: 401,
      message: 'Authorization required'
    })
  })

  it('returns 401 when DPoP header is missing', async () => {
    const { verifyDpopToken } = await importAuth()
    const result = await verifyDpopToken('DPoP some-token', undefined, URL, 'PUT', ALLOWED)
    expect(result).toEqual({
      success: false,
      statusCode: 401,
      message: 'DPoP header required'
    })
  })

  it('returns success when token verifies and webid is in allowlist', async () => {
    mockVerify.mockResolvedValueOnce({
      webid: 'https://alice.example/webid#me',
      iss: 'https://issuer.example',
      iat: 0,
      exp: 0,
      client_id: 'client1'
    })
    const { verifyDpopToken } = await importAuth()
    const result = await verifyDpopToken('DPoP some-token', 'dpop', URL, 'PUT', ALLOWED)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.payload.webid).toBe('https://alice.example/webid#me')
    }
    expect(mockVerify).toHaveBeenCalledWith(
      'DPoP some-token',
      { header: 'dpop', method: 'PUT', url: URL }
    )
  })

  it('returns 403 when token verifies but webid is not in allowlist', async () => {
    mockVerify.mockResolvedValueOnce({
      webid: 'https://mallory.example/webid#me',
      iss: 'https://issuer.example',
      iat: 0,
      exp: 0,
      client_id: 'client1'
    })
    const { verifyDpopToken } = await importAuth()
    const result = await verifyDpopToken('DPoP some-token', 'dpop', URL, 'PUT', ALLOWED)
    expect(result).toEqual({
      success: false,
      statusCode: 403,
      message: 'WebID not allowed'
    })
  })

  it('bypasses webid check when allowlist is empty', async () => {
    mockVerify.mockResolvedValueOnce({
      webid: 'https://anyone.example/webid#me',
      iss: 'https://issuer.example',
      iat: 0,
      exp: 0,
      client_id: 'client1'
    })
    const { verifyDpopToken } = await importAuth()
    const result = await verifyDpopToken('DPoP some-token', 'dpop', URL, 'PUT', [])
    expect(result.success).toBe(true)
  })

  it('returns 401 with verifier error message when token verification fails', async () => {
    mockVerify.mockRejectedValueOnce(new Error('invalid signature'))
    const { verifyDpopToken } = await importAuth()
    const result = await verifyDpopToken('DPoP bad-token', 'dpop', URL, 'PUT', ALLOWED)
    expect(result).toEqual({
      success: false,
      statusCode: 401,
      message: 'invalid signature'
    })
  })

  it('returns 401 with iat-skew logging when iat claim fails', async () => {
    const iatError = new Error('"iat" claim timestamp check failed')
    mockVerify.mockRejectedValueOnce(iatError)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const { verifyDpopToken } = await importAuth()
      const result = await verifyDpopToken('DPoP expired', 'dpop', URL, 'PUT', ALLOWED)
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.statusCode).toBe(401)
      }
      const messages = logSpy.mock.calls.map(args => args.map(String).join(' '))
      expect(messages.some(m => m.includes('iat') || m.includes('Iat'))).toBe(true)
    } finally {
      logSpy.mockRestore()
    }
  })

  it('passes the configured method to the verifier', async () => {
    mockVerify.mockResolvedValueOnce({
      webid: 'https://alice.example/webid#me',
      iss: 'https://issuer.example',
      iat: 0,
      exp: 0,
      client_id: 'client1'
    })
    const { verifyDpopToken } = await importAuth()
    await verifyDpopToken('DPoP t', 'dpop', URL, 'PUT', ALLOWED)
    expect(mockVerify).toHaveBeenCalledWith(
      'DPoP t',
      expect.objectContaining({ method: 'PUT' })
    )
  })
})