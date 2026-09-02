import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Context } from '@netlify/functions'

const mockVerifyDpopToken = vi.fn().mockResolvedValue({
  success: true,
  payload: {
    webid: 'https://alice.example/webid#me',
    iss: 'https://issuer.example',
    iat: 0,
    exp: 0,
    client_id: 'client1'
  }
})

vi.mock('../../src/auth.js', () => ({
  verifyDpopToken: mockVerifyDpopToken
}))

const mockFetchFileFromGitHub = vi.fn()
const mockIsPathSafe = vi.fn(() => true)
const mockCommitFileOnBranch = vi.fn()

vi.mock('../../src/github.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/github.js')>()
  return {
    ...actual,
    fetchFileFromGitHub: mockFetchFileFromGitHub,
    isPathSafe: mockIsPathSafe,
    commitFileOnBranch: mockCommitFileOnBranch
  }
})

vi.mock('../../src/config.js', () => ({
  loadWriteConfig: () => ({ writeWebIds: ['https://alice.example/webid#me'] }),
  loadGithubConfig: () => ({
    githubRepo: 'octocat/hello-world',
    githubToken: 'ghp_test',
    githubRef: 'HEAD'
  }),
  loadConfig: () => ({
    writeWebIds: ['https://alice.example/webid#me'],
    githubRepo: 'octocat/hello-world',
    githubToken: 'ghp_test',
    githubRef: 'HEAD'
  })
}))

function makeContext(overrides: Partial<Context> = {}): Context {
  return {
    requestId: 'test-request-id',
    server: { region: 'us-east-1' },
    waitUntil: vi.fn(),
    cookies: { get: vi.fn(), set: vi.fn(), delete: vi.fn() } as unknown as Context['cookies'],
    geo: {},
    ip: '127.0.0.1',
    site: {},
    deploy: { context: 'dev', id: 'test', published: false },
    account: { id: 'test' },
    json: vi.fn(),
    log: vi.fn(),
    next: vi.fn(),
    params: { page: 'foo', doc: 'bar' },
    rewrite: vi.fn(),
    ...overrides,
  } as unknown as Context
}

describe('router OPTIONS preflight', () => {
  it('returns 204 with default CORS headers when no Origin is provided', async () => {
    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/bar', { method: 'OPTIONS' })
    const res = await handler(req, makeContext())

    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('PUT, GET, OPTIONS')
    expect(res.headers.get('Access-Control-Allow-Headers')).toBe(
      'Authorization, DPoP, Content-Type, Accept, Date, Digest, Signature, If-None-Match, If-Match'
    )
    expect(res.headers.get('Access-Control-Expose-Headers')).toContain('WAC-Allow')
    expect(res.headers.get('Vary')).toBe('Origin')
  })

  it('echoes the Origin header when one is provided', async () => {
    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/bar', {
      method: 'OPTIONS',
      headers: { Origin: 'https://example.com' }
    })
    const res = await handler(req, makeContext())

    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://example.com')
    expect(res.headers.get('Vary')).toBe('Origin')
  })

  it('returns an empty body for OPTIONS', async () => {
    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/bar', { method: 'OPTIONS' })
    const res = await handler(req, makeContext())

    expect(await res.text()).toBe('')
  })
})

describe('router request handling', () => {
  beforeEach(() => {
    mockFetchFileFromGitHub.mockReset()
    mockFetchFileFromGitHub.mockResolvedValue({
      status: 200,
      body: new TextEncoder().encode('from-github'),
      contentType: 'text/plain',
      etag: null,
      cacheControl: null
    })
  })

  it('returns the upstream file body for GET /foo/bar', async () => {
    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/bar', { method: 'GET' })
    const res = await handler(req, makeContext({ params: { page: 'foo', doc: 'bar' } }))

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('from-github')
    expect(mockFetchFileFromGitHub).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'foo/bar' })
    )
  })

  it('returns the upstream file body for nested GET paths (regression: /blog/04/pantry.png)', async () => {
    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/blog/04/pantry.png', { method: 'GET' })
    const res = await handler(req, makeContext({ params: { page: 'blog/04', doc: 'pantry.png' } }))

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('from-github')
    expect(mockFetchFileFromGitHub).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'blog/04/pantry.png', ref: 'HEAD' })
    )
  })

  it('returns the upstream file body for nested draft GET paths', async () => {
    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/blog/04/history/draft/pantry.png', { method: 'GET' })
    const res = await handler(req, makeContext({ params: { page: 'blog/04', doc: 'pantry.png' } }))

    expect(res.status).toBe(200)
    expect(mockFetchFileFromGitHub).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'blog/04/pantry.png', ref: 'blog/04-draft' })
    )
  })

  it('returns 405 for PUT on a non-draft URL', async () => {
    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/api/events', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hello: 'world' })
    })
    const res = await handler(req, makeContext({ params: { page: 'api', doc: 'events' } }))

    expect(res.status).toBe(405)
    expect(mockCommitFileOnBranch).not.toHaveBeenCalled()
  })

  it('attaches CORS headers to non-OPTIONS responses', async () => {
    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/bar', {
      method: 'GET',
      headers: { Origin: 'https://example.com' }
    })
    const res = await handler(req, makeContext())

    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://example.com')
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('PUT, GET, OPTIONS')
    expect(res.headers.get('Access-Control-Allow-Headers')).toBe(
      'Authorization, DPoP, Content-Type, Accept, Date, Digest, Signature, If-None-Match, If-Match'
    )
    expect(res.headers.get('Vary')).toBe('Origin')
  })
})

describe('router PUT auth', () => {
  beforeEach(() => {
    mockVerifyDpopToken.mockReset()
    mockVerifyDpopToken.mockResolvedValue({
      success: true,
      payload: {
        webid: 'https://alice.example/webid#me',
        iss: 'https://issuer.example',
        iat: 0,
        exp: 0,
        client_id: 'client1'
      }
    })
    mockCommitFileOnBranch.mockReset()
    mockCommitFileOnBranch.mockResolvedValue({
      commitSha: 'c',
      htmlUrl: 'u',
      branch: 'api-draft'
    })
  })

  it('returns 401 when Authorization header is missing', async () => {
    mockVerifyDpopToken.mockResolvedValueOnce({
      success: false,
      statusCode: 401,
      message: 'Authorization required'
    })
    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/api/history/draft/events', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' }
    })
    const res = await handler(req, makeContext({ params: { page: 'api', doc: 'events' } }))

    expect(res.status).toBe(401)
    expect(await res.text()).toBe('Authorization required')
    expect(mockCommitFileOnBranch).not.toHaveBeenCalled()
  })

  it('returns 401 when DPoP header is missing', async () => {
    mockVerifyDpopToken.mockResolvedValueOnce({
      success: false,
      statusCode: 401,
      message: 'DPoP header required'
    })
    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/api/history/draft/events', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'authorization': 'DPoP some-token'
      }
    })
    const res = await handler(req, makeContext({ params: { page: 'api', doc: 'events' } }))

    expect(res.status).toBe(401)
    expect(await res.text()).toBe('DPoP header required')
  })

  it('returns 403 when token verifies but webid is not allowed', async () => {
    mockVerifyDpopToken.mockResolvedValueOnce({
      success: false,
      statusCode: 403,
      message: 'WebID not allowed'
    })
    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/api/history/draft/events', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'authorization': 'DPoP token',
        'dpop': 'dpop'
      }
    })
    const res = await handler(req, makeContext({ params: { page: 'api', doc: 'events' } }))

    expect(res.status).toBe(403)
    expect(await res.text()).toBe('WebID not allowed')
  })

  it('commits the body to the per-page draft branch and returns JSON commit info', async () => {
    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/api/history/draft/events', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'authorization': 'DPoP token',
        'dpop': 'dpop'
      },
      body: JSON.stringify({ ping: 'pong' })
    })
    const res = await handler(req, makeContext({ params: { page: 'api', doc: 'events' } }))

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('application/json')
    const body = await res.json()
    expect(body).toEqual({
      commit: 'c',
      url: 'u',
      branch: 'api-draft',
      path: 'api/events'
    })
    expect(mockCommitFileOnBranch).toHaveBeenCalledTimes(1)
    expect(mockCommitFileOnBranch).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: 'octocat/hello-world',
        token: 'ghp_test',
        baseRef: 'HEAD',
        branch: 'api-draft',
        path: 'api/events',
        content: Buffer.from(JSON.stringify({ ping: 'pong' })).toString('base64')
      })
    )
  })

  it('attaches CORS headers to PUT auth-failure responses', async () => {
    mockVerifyDpopToken.mockResolvedValueOnce({
      success: false,
      statusCode: 401,
      message: 'Authorization required'
    })
    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/api/history/draft/events', {
      method: 'PUT',
      headers: { Origin: 'https://example.com' }
    })
    const res = await handler(req, makeContext({ params: { page: 'api', doc: 'events' } }))

    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://example.com')
    expect(res.headers.get('Vary')).toBe('Origin')
  })

  it('propagates a 422 GitHub error from commitFileOnBranch', async () => {
    const { GitHubApiError } = await import('../../src/github.js')
    mockCommitFileOnBranch.mockRejectedValueOnce(new GitHubApiError('protected branch', 422))

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/api/history/draft/events', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'authorization': 'DPoP token',
        'dpop': 'dpop'
      },
      body: '{}'
    })
    const res = await handler(req, makeContext({ params: { page: 'api', doc: 'events' } }))

    expect(res.status).toBe(422)
    expect(await res.text()).toBe('protected branch')
  })
})

describe('router error handling', () => {
  it('returns 500 with the error message and still sets CORS headers', async () => {
    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/bar', {
      method: 'GET',
      headers: { Origin: 'https://example.com' }
    })
    const boom = new Error('boom')
    const ctx = makeContext()
    Object.defineProperty(ctx, 'params', {
      get() {
        throw boom
      },
      configurable: true
    })

    const res = await handler(req, ctx)

    expect(res.status).toBe(500)
    expect(await res.text()).toContain('boom')
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://example.com')
    expect(res.headers.get('Vary')).toBe('Origin')
  })

  it('logs the method and pathname before handling the request', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const { default: handler } = await import('../../netlify/functions/router/router.mts')
      const req = new Request('http://localhost/foo/bar', { method: 'GET' })
      const ctx = makeContext()

      await handler(req, ctx)

      expect(logSpy).toHaveBeenCalled()
      const messages = logSpy.mock.calls.map(args => args.map(String).join(' '))
      expect(messages.some(m => m.includes('[router] GET') && m.includes('/foo/bar'))).toBe(true)
    } finally {
      logSpy.mockRestore()
    }
  })
})
