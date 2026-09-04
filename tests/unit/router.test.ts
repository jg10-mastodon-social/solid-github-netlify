import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Context } from '@netlify/functions'
import { verifyDpopToken } from '../../src/auth.js'

vi.mock('../../src/auth.js', () => ({
  verifyDpopToken: vi.fn().mockResolvedValue({
    success: true,
    payload: { webid: 'https://alice.example/webid#me' }
  })
}))

const mockVerifyDpopToken = vi.mocked(verifyDpopToken)

const mockLoadWriteConfig: ReturnType<typeof vi.fn> & ((...args: unknown[]) => { writeWebIds: string[] }) =
  vi.fn(() => ({ writeWebIds: [] as string[] }))
const mockLoadGithubConfig = vi.fn(() => ({
  githubRepo: 'octocat/hello-world',
  githubToken: 'ghp_test',
  githubRef: 'HEAD'
}))

vi.mock('../../src/config.js', () => ({
  loadWriteConfig: mockLoadWriteConfig,
  loadGithubConfig: mockLoadGithubConfig,
  loadConfig: () => ({
    writeWebIds: [],
    githubRepo: 'octocat/hello-world',
    githubToken: 'ghp_test',
    githubRef: 'HEAD'
  })
}))

const mockFetchFileFromGitHub = vi.fn()
const mockIsPathSafe = vi.fn()
const mockCommitFileOnBranch = vi.fn()
const mockGetFileBlobSha = vi.fn()
const mockListDirectoryFromGitHub = vi.fn()
const mockListCommitsForPath = vi.fn()

vi.mock('../../src/github.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/github.js')>()
  return {
    ...actual,
    fetchFileFromGitHub: mockFetchFileFromGitHub,
    isPathSafe: mockIsPathSafe,
    commitFileOnBranch: mockCommitFileOnBranch,
    getFileBlobSha: mockGetFileBlobSha,
    listDirectoryFromGitHub: mockListDirectoryFromGitHub,
    listCommitsForPath: mockListCommitsForPath
  }
})

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
    ...overrides
  } as unknown as Context
}

describe('router config', () => {
  it('declares the history routes after the draft route so /history/draft/ is not swallowed', async () => {
    const { config } = await import('../../netlify/functions/router/router.mts')
    expect(config.path).toEqual([
      '/:page*/history/draft/',
      '/:page*/history/draft/:doc*',
      '/:page*/history/:rest*',
      '/:page*/',
      '/:page*/:doc',
      '/'
    ])
  })

  it('accepts PUT, GET, OPTIONS and PATCH methods', async () => {
    const { config } = await import('../../netlify/functions/router/router.mts')
    expect(config.method).toEqual(expect.arrayContaining(['PUT', 'GET', 'OPTIONS', 'PATCH']))
    expect(config.method).toHaveLength(4)
  })

  it('sets preferStatic to true so static assets win', async () => {
    const { config } = await import('../../netlify/functions/router/router.mts')
    expect(config.preferStatic).toBe(true)
  })
})

describe('router GET proxies a file from GitHub', () => {
  beforeEach(() => {
    mockFetchFileFromGitHub.mockReset()
    mockIsPathSafe.mockReset()
    mockIsPathSafe.mockReturnValue(true)
    mockLoadGithubConfig.mockReturnValue({
      githubRepo: 'octocat/hello-world',
      githubToken: 'ghp_test',
      githubRef: 'HEAD'
    })
  })

  function textBody(text: string): Uint8Array {
    return new TextEncoder().encode(text)
  }

  it('returns 200 with the upstream body and content-type', async () => {
    mockFetchFileFromGitHub.mockResolvedValueOnce({
      status: 200,
      body: textBody('# Hello'),
      contentType: 'text/markdown; charset=utf-8',
      etag: 'W/"abc"',
      cacheControl: null
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/bar', { method: 'GET' })
    const res = await handler(req, makeContext({ params: { page: 'foo', doc: 'bar' } }))

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('# Hello')
    expect(res.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8')
    expect(res.headers.get('ETag')).toBe('W/"abc"')
  })

  it('returns binary content without UTF-8 corruption', async () => {
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00, 0x80])
    mockFetchFileFromGitHub.mockResolvedValueOnce({
      status: 200,
      body: pngBytes,
      contentType: 'image/png',
      etag: 'W/"abc"',
      cacheControl: null
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/images/logo.png', { method: 'GET' })
    const res = await handler(req, makeContext({ params: { page: 'images', doc: 'logo.png' } }))

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/png')
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect(Array.from(bytes)).toEqual(Array.from(pngBytes))
  })

  it('returns text/html for .html paths instead of GitHub raw content-type', async () => {
    mockFetchFileFromGitHub.mockResolvedValueOnce({
      status: 200,
      body: textBody('<html></html>'),
      contentType: 'text/html; charset=utf-8',
      etag: 'W/"abc"',
      cacheControl: null
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/index.html', { method: 'GET' })
    const res = await handler(req, makeContext({ params: { page: 'foo', doc: 'index.html' } }))

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
  })

  it('forwards the upstream Cache-Control header', async () => {
    mockFetchFileFromGitHub.mockResolvedValueOnce({
      status: 200,
      body: textBody('ok'),
      contentType: 'text/plain',
      etag: 'W/"abc"',
      cacheControl: 'private, max-age=60'
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/bar', { method: 'GET' })
    const res = await handler(req, makeContext({ params: { page: 'foo', doc: 'bar' } }))

    expect(res.headers.get('Cache-Control')).toBe('private, max-age=60')
  })

  it('assembles path from page and doc on the published route', async () => {
    mockFetchFileFromGitHub.mockResolvedValueOnce({
      status: 200,
      body: textBody('ok'),
      contentType: 'text/plain',
      etag: null,
      cacheControl: null
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/bar', { method: 'GET' })
    await handler(req, makeContext({ params: { page: 'foo', doc: 'bar' } }))

    expect(mockFetchFileFromGitHub).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'foo/bar' })
    )
  })

  it('assembles nested segment paths from page and doc (regression: /blog/04/pantry.png)', async () => {
    mockFetchFileFromGitHub.mockResolvedValueOnce({
      status: 200,
      body: textBody('ok'),
      contentType: 'image/png',
      etag: null,
      cacheControl: null
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/blog/04/pantry.png', { method: 'GET' })
    await handler(req, makeContext({ params: { page: 'blog/04', doc: 'pantry.png' } }))

    expect(mockFetchFileFromGitHub).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'blog/04/pantry.png' })
    )
  })

  it('uses config.githubRef as the ref on the published route', async () => {
    mockFetchFileFromGitHub.mockResolvedValueOnce({
      status: 200,
      body: textBody('ok'),
      contentType: 'text/plain',
      etag: null,
      cacheControl: null
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/bar', { method: 'GET' })
    await handler(req, makeContext({ params: { page: 'foo', doc: 'bar' } }))

    expect(mockFetchFileFromGitHub).toHaveBeenCalledWith(
      expect.objectContaining({ ref: 'HEAD' })
    )
  })

  it('passes If-None-Match to GitHub and returns 304 on a 304 upstream', async () => {
    mockFetchFileFromGitHub.mockResolvedValueOnce({
      status: 304,
      body: textBody(''),
      contentType: null,
      etag: 'W/"abc"',
      cacheControl: null
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/bar', {
      method: 'GET',
      headers: { 'If-None-Match': 'W/"abc"' }
    })
    const res = await handler(req, makeContext({ params: { page: 'foo', doc: 'bar' } }))

    expect(mockFetchFileFromGitHub).toHaveBeenCalledWith(
      expect.objectContaining({ ifNoneMatch: 'W/"abc"' })
    )
    expect(res.status).toBe(304)
    expect(res.headers.get('ETag')).toBe('W/"abc"')
  })

  it('returns 404 when GitHub reports a missing file', async () => {
    mockFetchFileFromGitHub.mockResolvedValueOnce({
      status: 404,
      body: textBody('Not Found'),
      contentType: 'text/plain',
      etag: null,
      cacheControl: null
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/missing', { method: 'GET' })
    const res = await handler(req, makeContext({ params: { page: 'foo', doc: 'missing' } }))

    expect(res.status).toBe(404)
    expect(await res.text()).toBe('Not Found')
  })

  it('returns 400 when the assembled path is unsafe', async () => {
    mockIsPathSafe.mockReturnValueOnce(false)

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/..%2Fsecret', { method: 'GET' })
    const res = await handler(req, makeContext({ params: { page: 'foo', doc: '../secret' } }))

    expect(res.status).toBe(400)
    expect(mockFetchFileFromGitHub).not.toHaveBeenCalled()
  })

  it('returns 502 when the GitHub fetch throws', async () => {
    mockFetchFileFromGitHub.mockRejectedValueOnce(new Error('upstream down'))

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/bar', { method: 'GET' })
    const res = await handler(req, makeContext({ params: { page: 'foo', doc: 'bar' } }))

    expect(res.status).toBe(502)
    expect(await res.text()).toBe('upstream down')
  })

  it('exposes ETag header via CORS', async () => {
    mockFetchFileFromGitHub.mockResolvedValueOnce({
      status: 200,
      body: textBody('ok'),
      contentType: 'text/plain',
      etag: 'W/"abc"',
      cacheControl: null
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/bar', {
      method: 'GET',
      headers: { Origin: 'https://example.com' }
    })
    const res = await handler(req, makeContext({ params: { page: 'foo', doc: 'bar' } }))

    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://example.com')
    expect(res.headers.get('Access-Control-Expose-Headers')).toContain('ETag')
  })
})

describe('router GET on draft route', () => {
  beforeEach(() => {
    mockFetchFileFromGitHub.mockReset()
    mockIsPathSafe.mockReset()
    mockIsPathSafe.mockReturnValue(true)
    mockLoadGithubConfig.mockReturnValue({
      githubRepo: 'octocat/hello-world',
      githubToken: 'ghp_test',
      githubRef: 'HEAD'
    })
  })

  function textBody(text: string): Uint8Array {
    return new TextEncoder().encode(text)
  }

  it('reads from the per-page draft branch and the same page/doc file path', async () => {
    mockFetchFileFromGitHub.mockResolvedValueOnce({
      status: 200,
      body: textBody('draft content'),
      contentType: 'text/markdown; charset=utf-8',
      etag: 'W/"draft"',
      cacheControl: null
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/draft/bar', { method: 'GET' })
    const res = await handler(req, makeContext({ params: { page: 'foo', doc: 'bar' } }))

    expect(mockFetchFileFromGitHub).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'foo/bar', ref: 'foo-draft' })
    )
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('draft content')
  })

  it('reads nested segment paths from the per-page draft branch (regression: /blog/04/...)', async () => {
    mockFetchFileFromGitHub.mockResolvedValueOnce({
      status: 200,
      body: textBody('draft content'),
      contentType: 'text/plain',
      etag: null,
      cacheControl: null
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/blog/04/history/draft/pantry.png', { method: 'GET' })
    await handler(req, makeContext({ params: { page: 'blog/04', doc: 'pantry.png' } }))

    expect(mockFetchFileFromGitHub).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'blog/04/pantry.png', ref: 'blog/04-draft' })
    )
  })

  it('returns 400 when the assembled path is unsafe on the draft route', async () => {
    mockIsPathSafe.mockReturnValueOnce(false)

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/draft/..%2Fsecret', { method: 'GET' })
    const res = await handler(req, makeContext({ params: { page: 'foo', doc: '../secret' } }))

    expect(res.status).toBe(400)
    expect(mockFetchFileFromGitHub).not.toHaveBeenCalled()
  })
})

describe('router PUT method handling', () => {
  beforeEach(() => {
    mockCommitFileOnBranch.mockReset()
    mockIsPathSafe.mockReset()
    mockIsPathSafe.mockReturnValue(true)
    mockLoadGithubConfig.mockReturnValue({
      githubRepo: 'octocat/hello-world',
      githubToken: 'ghp_test',
      githubRef: 'HEAD'
    })
  })

  it('returns 405 when PUT is sent to a non-draft URL', async () => {
    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/bar', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ping: 'pong' })
    })
    const res = await handler(req, makeContext({ params: { page: 'foo', doc: 'bar' } }))

    expect(res.status).toBe(405)
    expect(mockCommitFileOnBranch).not.toHaveBeenCalled()
  })
})

describe('router PUT commit flow', () => {
  beforeEach(() => {
    mockCommitFileOnBranch.mockReset()
    mockIsPathSafe.mockReset()
    mockIsPathSafe.mockReturnValue(true)
    mockLoadGithubConfig.mockReturnValue({
      githubRepo: 'octocat/hello-world',
      githubToken: 'ghp_test',
      githubRef: 'HEAD'
    })
  })

  it('returns 200 with JSON commit info on a successful commit', async () => {
    mockCommitFileOnBranch.mockResolvedValueOnce({
      commitSha: 'commit-sha',
      htmlUrl: 'https://github.com/octocat/hello-world/commit/abc',
      branch: 'foo-draft'
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/draft/bar', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hello: 'world' })
    })
    const res = await handler(req, makeContext({ params: { page: 'foo', doc: 'bar' } }))

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('application/json')
    const body = await res.json()
    expect(body).toEqual({
      commit: 'commit-sha',
      url: 'https://github.com/octocat/hello-world/commit/abc',
      branch: 'foo-draft',
      path: 'foo/bar'
    })
  })

  it('passes page/doc as path, base64 content, and the per-page branch to commitFileOnBranch', async () => {
    mockCommitFileOnBranch.mockResolvedValueOnce({
      commitSha: 'c',
      htmlUrl: 'u',
      branch: 'foo-draft'
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const body = 'hello world'
    const req = new Request('http://localhost/foo/history/draft/bar', {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body
    })
    await handler(req, makeContext({ params: { page: 'foo', doc: 'bar' } }))

    expect(mockCommitFileOnBranch).toHaveBeenCalledTimes(1)
    expect(mockCommitFileOnBranch).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: 'octocat/hello-world',
        token: 'ghp_test',
        baseRef: 'HEAD',
        branch: 'foo-draft',
        path: 'foo/bar',
        content: Buffer.from(body).toString('base64'),
        message: expect.stringContaining('foo/bar')
      })
    )
  })

  it('returns 400 when the assembled path is unsafe', async () => {
    mockIsPathSafe.mockReturnValueOnce(false)

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/draft/..%2Fsecret', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    })
    const res = await handler(req, makeContext({ params: { page: 'foo', doc: '../secret' } }))

    expect(res.status).toBe(400)
    expect(mockCommitFileOnBranch).not.toHaveBeenCalled()
  })

  it('propagates GitHubApiError status as the response status', async () => {
    const { GitHubApiError } = await import('../../src/github.js')
    mockCommitFileOnBranch.mockRejectedValueOnce(
      new GitHubApiError('branch protected', 422)
    )

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/draft/bar', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    })
    const res = await handler(req, makeContext({ params: { page: 'foo', doc: 'bar' } }))

    expect(res.status).toBe(422)
    expect(await res.text()).toBe('branch protected')
  })

  it('returns 502 on GitHub 5xx errors', async () => {
    const { GitHubApiError } = await import('../../src/github.js')
    mockCommitFileOnBranch.mockRejectedValueOnce(
      new GitHubApiError('upstream down', 502)
    )

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/draft/bar', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    })
    const res = await handler(req, makeContext({ params: { page: 'foo', doc: 'bar' } }))

    expect(res.status).toBe(502)
    expect(await res.text()).toBe('upstream down')
  })

  it('returns 502 on network errors', async () => {
    mockCommitFileOnBranch.mockRejectedValueOnce(new Error('network down'))

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/draft/bar', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    })
    const res = await handler(req, makeContext({ params: { page: 'foo', doc: 'bar' } }))

    expect(res.status).toBe(502)
    expect(await res.text()).toBe('network down')
  })
})

describe('router WAC-Allow on draft GET', () => {
  beforeEach(() => {
    mockFetchFileFromGitHub.mockReset()
    mockIsPathSafe.mockReset()
    mockIsPathSafe.mockReturnValue(true)
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
    mockLoadWriteConfig.mockReturnValue({ writeWebIds: ['https://alice.example/webid#me'] })
    mockLoadGithubConfig.mockReturnValue({
      githubRepo: 'octocat/hello-world',
      githubToken: 'ghp_test',
      githubRef: 'HEAD'
    })
  })

  function textBody(text: string): Uint8Array {
    return new TextEncoder().encode(text)
  }

  function okResult() {
    return {
      status: 200,
      body: textBody('draft'),
      contentType: 'text/plain',
      etag: null as string | null,
      cacheControl: null as string | null
    }
  }

  it('returns WAC-Allow with user="read write" for an authenticated allowed webid', async () => {
    mockFetchFileFromGitHub.mockResolvedValueOnce(okResult())

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/draft/bar', {
      method: 'GET',
      headers: {
        authorization: 'DPoP token',
        dpop: 'dpop-proof'
      }
    })
    const res = await handler(req, makeContext({ params: { page: 'foo', doc: 'bar' } }))

    expect(res.headers.get('WAC-Allow')).toBe('user="read write", public="read"')
  })

  it('returns WAC-Allow with user="read" when no Authorization header is present', async () => {
    mockFetchFileFromGitHub.mockResolvedValueOnce(okResult())

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/draft/bar', { method: 'GET' })
    const res = await handler(req, makeContext({ params: { page: 'foo', doc: 'bar' } }))

    expect(res.headers.get('WAC-Allow')).toBe('user="read", public="read"')
  })

  it('returns WAC-Allow with user="read" when no DPoP header is present', async () => {
    mockFetchFileFromGitHub.mockResolvedValueOnce(okResult())

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/draft/bar', {
      method: 'GET',
      headers: { authorization: 'DPoP token' }
    })
    const res = await handler(req, makeContext({ params: { page: 'foo', doc: 'bar' } }))

    expect(res.headers.get('WAC-Allow')).toBe('user="read", public="read"')
  })

  it('returns WAC-Allow with user="read" when the authenticated webid is not in WRITE_WEBIDS', async () => {
    mockVerifyDpopToken.mockResolvedValueOnce({
      success: true,
      payload: {
        webid: 'https://mallory.example/webid#me',
        iss: 'https://issuer.example',
        iat: 0,
        exp: 0,
        client_id: 'client1'
      }
    })
    mockFetchFileFromGitHub.mockResolvedValueOnce(okResult())

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/draft/bar', {
      method: 'GET',
      headers: {
        authorization: 'DPoP token',
        dpop: 'dpop-proof'
      }
    })
    const res = await handler(req, makeContext({ params: { page: 'foo', doc: 'bar' } }))

    expect(res.headers.get('WAC-Allow')).toBe('user="read", public="read"')
  })

  it('returns WAC-Allow with user="read" when verifyDpopToken returns a failure result', async () => {
    mockVerifyDpopToken.mockResolvedValueOnce({
      success: false,
      statusCode: 403,
      message: 'WebID not allowed'
    })
    mockFetchFileFromGitHub.mockResolvedValueOnce(okResult())

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/draft/bar', {
      method: 'GET',
      headers: {
        authorization: 'DPoP token',
        dpop: 'dpop-proof'
      }
    })
    const res = await handler(req, makeContext({ params: { page: 'foo', doc: 'bar' } }))

    expect(res.headers.get('WAC-Allow')).toBe('user="read", public="read"')
  })

  it('does not call verifyDpopToken when neither auth header is present', async () => {
    mockFetchFileFromGitHub.mockResolvedValueOnce(okResult())

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/draft/bar', { method: 'GET' })
    await handler(req, makeContext({ params: { page: 'foo', doc: 'bar' } }))

    expect(mockVerifyDpopToken).not.toHaveBeenCalled()
  })

  it('passes GET as the expected method to verifyDpopToken on draft routes', async () => {
    mockFetchFileFromGitHub.mockResolvedValueOnce(okResult())

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/draft/bar', {
      method: 'GET',
      headers: {
        authorization: 'DPoP token',
        dpop: 'dpop-proof'
      }
    })
    await handler(req, makeContext({ params: { page: 'foo', doc: 'bar' } }))

    expect(mockVerifyDpopToken).toHaveBeenCalledWith(
      'DPoP token',
      'dpop-proof',
      expect.any(String),
      'GET',
      ['https://alice.example/webid#me']
    )
  })

  it('includes WAC-Allow on 304 Not Modified responses', async () => {
    mockFetchFileFromGitHub.mockResolvedValueOnce({
      status: 304,
      body: textBody(''),
      contentType: null,
      etag: 'W/"abc"',
      cacheControl: null
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/draft/bar', { method: 'GET' })
    const res = await handler(req, makeContext({ params: { page: 'foo', doc: 'bar' } }))

    expect(res.status).toBe(304)
    expect(res.headers.get('WAC-Allow')).toBe('user="read", public="read"')
  })

  it('includes WAC-Allow on 404 Not Found responses (both draft and main miss)', async () => {
    mockFetchFileFromGitHub
      .mockResolvedValueOnce({
        status: 404,
        body: textBody('Not Found'),
        contentType: 'text/plain',
        etag: null,
        cacheControl: null
      })
      .mockResolvedValueOnce({
        status: 404,
        body: textBody('Not Found'),
        contentType: 'text/plain',
        etag: null,
        cacheControl: null
      })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/draft/bar', { method: 'GET' })
    const res = await handler(req, makeContext({ params: { page: 'foo', doc: 'bar' } }))

    expect(res.status).toBe(404)
    expect(res.headers.get('WAC-Allow')).toBe('user="read", public="read"')
    expect(mockFetchFileFromGitHub).toHaveBeenCalledTimes(2)
  })

  it('falls back to GITHUB_REF on draft 404 with file present on main', async () => {
    mockFetchFileFromGitHub
      .mockResolvedValueOnce({
        status: 404,
        body: textBody('Not Found'),
        contentType: 'text/plain',
        etag: null,
        cacheControl: null
      })
      .mockResolvedValueOnce({
        status: 200,
        body: textBody('main-content'),
        contentType: 'text/html',
        etag: '"abc123"',
        cacheControl: 'max-age=60'
      })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/blog/history/draft/home.html', { method: 'GET' })
    const res = await handler(req, makeContext({ params: { page: 'blog', doc: 'home.html' } }))

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('main-content')
    expect(res.headers.get('Content-Type')).toBe('text/html')
    expect(res.headers.get('ETag')).toBe('"abc123"')
    expect(res.headers.get('Cache-Control')).toBe('max-age=60')
    expect(res.headers.get('WAC-Allow')).toBe('user="read", public="read"')
    expect(mockFetchFileFromGitHub).toHaveBeenCalledTimes(2)
    expect(mockFetchFileFromGitHub.mock.calls[0][0]).toEqual(
      expect.objectContaining({ ref: 'blog-draft', path: 'blog/home.html' })
    )
    expect(mockFetchFileFromGitHub.mock.calls[1][0]).toEqual(
      expect.objectContaining({ ref: 'HEAD', path: 'blog/home.html' })
    )
  })

  it('forwards If-None-Match to the fallback fetch on draft 404', async () => {
    mockFetchFileFromGitHub
      .mockResolvedValueOnce({
        status: 404,
        body: textBody('Not Found'),
        contentType: 'text/plain',
        etag: null,
        cacheControl: null
      })
      .mockResolvedValueOnce({
        status: 200,
        body: textBody('main-content'),
        contentType: 'text/html',
        etag: '"abc123"',
        cacheControl: null
      })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/blog/history/draft/home.html', {
      method: 'GET',
      headers: { 'if-none-match': '"old-sha"' }
    })
    await handler(req, makeContext({ params: { page: 'blog', doc: 'home.html' } }))

    expect(mockFetchFileFromGitHub.mock.calls[0][0]).toEqual(
      expect.objectContaining({ ifNoneMatch: '"old-sha"' })
    )
    expect(mockFetchFileFromGitHub.mock.calls[1][0]).toEqual(
      expect.objectContaining({ ifNoneMatch: '"old-sha"' })
    )
  })

  it('does not fall back on non-draft 404', async () => {
    mockFetchFileFromGitHub.mockResolvedValueOnce({
      status: 404,
      body: textBody('Not Found'),
      contentType: 'text/plain',
      etag: null,
      cacheControl: null
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/bar', { method: 'GET' })
    const res = await handler(req, makeContext({ params: { page: 'foo', doc: 'bar' } }))

    expect(res.status).toBe(404)
    expect(res.headers.get('WAC-Allow')).toBeNull()
    expect(mockFetchFileFromGitHub).toHaveBeenCalledTimes(1)
  })

  it('emits WAC-Allow=write on fallback for authenticated allowlisted WebID', async () => {
    mockFetchFileFromGitHub
      .mockResolvedValueOnce({
        status: 404,
        body: textBody('Not Found'),
        contentType: 'text/plain',
        etag: null,
        cacheControl: null
      })
      .mockResolvedValueOnce({
        status: 200,
        body: textBody('main-content'),
        contentType: 'text/html',
        etag: '"abc123"',
        cacheControl: null
      })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/blog/history/draft/home.html', {
      method: 'GET',
      headers: {
        authorization: 'DPoP token',
        dpop: 'dpop-proof'
      }
    })
    const res = await handler(req, makeContext({ params: { page: 'blog', doc: 'home.html' } }))

    expect(res.status).toBe(200)
    expect(res.headers.get('WAC-Allow')).toBe('user="read write", public="read"')
  })

  it('omits WAC-Allow on 400 Unsafe Path responses', async () => {
    mockIsPathSafe.mockReturnValueOnce(false)

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/draft/..%2Fsecret', { method: 'GET' })
    const res = await handler(req, makeContext({ params: { page: 'foo', doc: '../secret' } }))

    expect(res.status).toBe(400)
    expect(res.headers.get('WAC-Allow')).toBeNull()
  })

  it('omits WAC-Allow on 502 upstream error responses', async () => {
    mockFetchFileFromGitHub.mockRejectedValueOnce(new Error('upstream down'))

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/draft/bar', { method: 'GET' })
    const res = await handler(req, makeContext({ params: { page: 'foo', doc: 'bar' } }))

    expect(res.status).toBe(502)
    expect(res.headers.get('WAC-Allow')).toBeNull()
  })
})

describe('router WAC-Allow omitted on published GET', () => {
  beforeEach(() => {
    mockFetchFileFromGitHub.mockReset()
    mockIsPathSafe.mockReset()
    mockIsPathSafe.mockReturnValue(true)
    mockLoadGithubConfig.mockReturnValue({
      githubRepo: 'octocat/hello-world',
      githubToken: 'ghp_test',
      githubRef: 'HEAD'
    })
  })

  it('does not include WAC-Allow on the published route', async () => {
    mockFetchFileFromGitHub.mockResolvedValueOnce({
      status: 200,
      body: new TextEncoder().encode('ok'),
      contentType: 'text/plain',
      etag: null,
      cacheControl: null
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/bar', { method: 'GET' })
    const res = await handler(req, makeContext({ params: { page: 'foo', doc: 'bar' } }))

    expect(res.status).toBe(200)
    expect(res.headers.get('WAC-Allow')).toBeNull()
  })

  it('exposes WAC-Allow via Access-Control-Expose-Headers on the published route CORS preflight', async () => {
    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/bar', { method: 'OPTIONS' })
    const res = await handler(req, makeContext({ params: { page: 'foo', doc: 'bar' } }))

    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Expose-Headers')).toContain('WAC-Allow')
  })
})

describe('router draft GET advertises editing headers (CSS-aligned)', () => {
  beforeEach(() => {
    mockFetchFileFromGitHub.mockReset()
    mockIsPathSafe.mockReset()
    mockIsPathSafe.mockReturnValue(true)
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
    mockLoadWriteConfig.mockReturnValue({ writeWebIds: [] })
    mockLoadGithubConfig.mockReturnValue({
      githubRepo: 'octocat/hello-world',
      githubToken: 'ghp_test',
      githubRef: 'HEAD'
    })
  })

  function textBody(text: string): Uint8Array {
    return new TextEncoder().encode(text)
  }

  it('emits Allow, Accept-Put, Accept-Patch on a 200 draft GET with RDF content-type', async () => {
    mockFetchFileFromGitHub.mockResolvedValueOnce({
      status: 200,
      body: textBody('@ Hello'),
      contentType: 'text/turtle; charset=utf-8',
      etag: 'W/"abc"',
      cacheControl: null
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/draft/data.ttl', { method: 'GET' })
    const res = await handler(req, makeContext({ params: { page: 'foo', doc: 'data.ttl' } }))

    expect(res.headers.get('Allow')).toBe('GET, PUT, OPTIONS')
    expect(res.headers.get('Accept-Put')).toBe('*/*')
    expect(res.headers.get('Accept-Patch')).toBe('text/n3')
  })

  it('emits Allow, Accept-Put, Accept-Patch on a 200 draft GET with HTML content-type (CSS advertises PATCH on HTML too)', async () => {
    mockFetchFileFromGitHub.mockResolvedValueOnce({
      status: 200,
      body: textBody('<html></html>'),
      contentType: 'text/html; charset=utf-8',
      etag: 'W/"abc"',
      cacheControl: null
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/draft/index.html', { method: 'GET' })
    const res = await handler(req, makeContext({ params: { page: 'foo', doc: 'index.html' } }))

    expect(res.headers.get('Allow')).toBe('GET, PUT, OPTIONS')
    expect(res.headers.get('Accept-Put')).toBe('*/*')
    expect(res.headers.get('Accept-Patch')).toBe('text/n3')
  })

  it('emits editing headers on a 304 draft GET', async () => {
    mockFetchFileFromGitHub.mockResolvedValueOnce({
      status: 304,
      body: textBody(''),
      contentType: null,
      etag: 'W/"abc"',
      cacheControl: null
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/draft/data.ttl', { method: 'GET' })
    const res = await handler(req, makeContext({ params: { page: 'foo', doc: 'data.ttl' } }))

    expect(res.status).toBe(304)
    expect(res.headers.get('Allow')).toBe('GET, PUT, OPTIONS')
    expect(res.headers.get('Accept-Put')).toBe('*/*')
    expect(res.headers.get('Accept-Patch')).toBe('text/n3')
  })

  it('emits editing headers on a 404 draft GET (both draft and main miss)', async () => {
    mockFetchFileFromGitHub
      .mockResolvedValueOnce({
        status: 404,
        body: textBody('Not Found'),
        contentType: 'text/plain',
        etag: null,
        cacheControl: null
      })
      .mockResolvedValueOnce({
        status: 404,
        body: textBody('Not Found'),
        contentType: 'text/plain',
        etag: null,
        cacheControl: null
      })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/draft/missing.ttl', { method: 'GET' })
    const res = await handler(req, makeContext({ params: { page: 'foo', doc: 'missing.ttl' } }))

    expect(res.status).toBe(404)
    expect(res.headers.get('Allow')).toBe('GET, PUT, OPTIONS')
    expect(res.headers.get('Accept-Put')).toBe('*/*')
    expect(res.headers.get('Accept-Patch')).toBe('text/n3')
  })

  it('emits editing headers when the draft GET falls back to the main branch', async () => {
    mockFetchFileFromGitHub
      .mockResolvedValueOnce({
        status: 404,
        body: textBody('Not Found'),
        contentType: 'text/plain',
        etag: null,
        cacheControl: null
      })
      .mockResolvedValueOnce({
        status: 200,
        body: textBody('main'),
        contentType: 'text/html; charset=utf-8',
        etag: 'W/"main"',
        cacheControl: null
      })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/blog/history/draft/home.html', { method: 'GET' })
    const res = await handler(req, makeContext({ params: { page: 'blog', doc: 'home.html' } }))

    expect(res.status).toBe(200)
    expect(res.headers.get('Allow')).toBe('GET, PUT, OPTIONS')
    expect(res.headers.get('Accept-Put')).toBe('*/*')
    expect(res.headers.get('Accept-Patch')).toBe('text/n3')
  })

  it('does not emit editing headers on a 502 upstream error', async () => {
    mockFetchFileFromGitHub.mockRejectedValueOnce(new Error('upstream down'))

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/draft/data.ttl', { method: 'GET' })
    const res = await handler(req, makeContext({ params: { page: 'foo', doc: 'data.ttl' } }))

    expect(res.status).toBe(502)
    expect(res.headers.get('Allow')).toBeNull()
    expect(res.headers.get('Accept-Patch')).toBeNull()
  })

  it('does not emit editing headers on a 400 Unsafe Path response', async () => {
    mockIsPathSafe.mockReturnValueOnce(false)

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/draft/..%2Fsecret', { method: 'GET' })
    const res = await handler(req, makeContext({ params: { page: 'foo', doc: '../secret' } }))

    expect(res.status).toBe(400)
    expect(res.headers.get('Allow')).toBeNull()
    expect(res.headers.get('Accept-Patch')).toBeNull()
  })

  it('does not emit editing headers on the published route', async () => {
    mockFetchFileFromGitHub.mockResolvedValueOnce({
      status: 200,
      body: textBody('ok'),
      contentType: 'text/plain',
      etag: null,
      cacheControl: null
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/bar', { method: 'GET' })
    const res = await handler(req, makeContext({ params: { page: 'foo', doc: 'bar' } }))

    expect(res.headers.get('Allow')).toBeNull()
    expect(res.headers.get('Accept-Put')).toBeNull()
    expect(res.headers.get('Accept-Patch')).toBeNull()
  })

  it('exposes Allow, Accept-Put, Accept-Patch via Access-Control-Expose-Headers on OPTIONS', async () => {
    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/draft/data.ttl', { method: 'OPTIONS' })
    const res = await handler(req, makeContext({ params: { page: 'foo', doc: 'data.ttl' } }))

    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Expose-Headers')).toContain('Allow')
    expect(res.headers.get('Access-Control-Expose-Headers')).toContain('Accept-Put')
    expect(res.headers.get('Access-Control-Expose-Headers')).toContain('Accept-Patch')
  })
})

describe('router PATCH handler', () => {
  beforeEach(() => {
    mockFetchFileFromGitHub.mockReset()
    mockCommitFileOnBranch.mockReset()
    mockGetFileBlobSha.mockReset()
    mockGetFileBlobSha.mockResolvedValue(null)
    mockIsPathSafe.mockReset()
    mockIsPathSafe.mockReturnValue(true)
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
    mockLoadWriteConfig.mockReturnValue({ writeWebIds: ['https://alice.example/webid#me'] })
    mockLoadGithubConfig.mockReturnValue({
      githubRepo: 'octocat/hello-world',
      githubToken: 'ghp_test',
      githubRef: 'HEAD'
    })
  })

  function textBody(text: string): Uint8Array {
    return new TextEncoder().encode(text)
  }

  const PREFIXES = `@prefix solid: <http://www.w3.org/ns/solid/terms#>.
@prefix ex: <http://www.example.org/terms#>.
`
  function patchBody(inserts: string, opts: { where?: string; deletes?: string } = {}): string {
    let body = PREFIXES + '\n_:patch'
    if (opts.where) body += `\n      solid:where { ${opts.where} };`
    if (opts.deletes) body += `\n      solid:deletes { ${opts.deletes} };`
    body += `\n      solid:inserts { ${inserts} };\n   a solid:InsertDeletePatch .\n`
    return body
  }

  it('returns 405 when PATCH is sent to a non-draft URL', async () => {
    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/data.ttl', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'text/n3',
        authorization: 'DPoP token',
        dpop: 'dpop'
      },
      body: patchBody('ex:alice ex:p ex:bob .')
    })
    const res = await handler(req, makeContext({ params: { page: 'foo', doc: 'data.ttl' } }))

    expect(res.status).toBe(405)
    expect(mockCommitFileOnBranch).not.toHaveBeenCalled()
  })

  it('returns 401 when DPoP auth fails', async () => {
    mockVerifyDpopToken.mockResolvedValueOnce({
      success: false,
      statusCode: 401,
      message: 'invalid token'
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/draft/data.ttl', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'text/n3',
        authorization: 'DPoP token',
        dpop: 'dpop'
      },
      body: patchBody('ex:alice ex:p ex:bob .')
    })
    const res = await handler(req, makeContext({ params: { page: 'foo', doc: 'data.ttl' } }))

    expect(res.status).toBe(401)
    expect(mockCommitFileOnBranch).not.toHaveBeenCalled()
  })

  it('returns 415 when Content-Type is not text/n3', async () => {
    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/draft/data.ttl', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/sparql-update',
        authorization: 'DPoP token',
        dpop: 'dpop'
      },
      body: patchBody('ex:alice ex:p ex:bob .')
    })
    const res = await handler(req, makeContext({ params: { page: 'foo', doc: 'data.ttl' } }))

    expect(res.status).toBe(415)
    expect(mockCommitFileOnBranch).not.toHaveBeenCalled()
  })

  it('returns 422 when the path does not end in .ttl', async () => {
    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/draft/data.html', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'text/n3',
        authorization: 'DPoP token',
        dpop: 'dpop'
      },
      body: patchBody('ex:alice ex:p ex:bob .')
    })
    const res = await handler(req, makeContext({ params: { page: 'foo', doc: 'data.html' } }))

    expect(res.status).toBe(422)
    expect(mockCommitFileOnBranch).not.toHaveBeenCalled()
  })

  it('returns 422 when the patch body has solid:where non-empty', async () => {
    mockFetchFileFromGitHub.mockResolvedValueOnce({
      status: 404,
      body: textBody(''),
      contentType: null,
      etag: null,
      cacheControl: null
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/draft/data.ttl', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'text/n3',
        authorization: 'DPoP token',
        dpop: 'dpop'
      },
      body: patchBody('ex:a ex:p ex:b .', { where: '?s ex:p ?o' })
    })
    const res = await handler(req, makeContext({ params: { page: 'foo', doc: 'data.ttl' } }))

    expect(res.status).toBe(422)
    expect(mockCommitFileOnBranch).not.toHaveBeenCalled()
  })

  it('returns 422 when the patch body has solid:deletes non-empty', async () => {
    mockFetchFileFromGitHub.mockResolvedValueOnce({
      status: 404,
      body: textBody(''),
      contentType: null,
      etag: null,
      cacheControl: null
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/draft/data.ttl', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'text/n3',
        authorization: 'DPoP token',
        dpop: 'dpop'
      },
      body: patchBody('ex:a ex:p ex:b .', { deletes: 'ex:c ex:p ex:d' })
    })
    const res = await handler(req, makeContext({ params: { page: 'foo', doc: 'data.ttl' } }))

    expect(res.status).toBe(422)
    expect(mockCommitFileOnBranch).not.toHaveBeenCalled()
  })

  it('returns 422 when the patch body has a blank node in inserts', async () => {
    mockFetchFileFromGitHub.mockResolvedValueOnce({
      status: 404,
      body: textBody(''),
      contentType: null,
      etag: null,
      cacheControl: null
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/draft/data.ttl', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'text/n3',
        authorization: 'DPoP token',
        dpop: 'dpop'
      },
      body: patchBody('_:b ex:p ex:o .')
    })
    const res = await handler(req, makeContext({ params: { page: 'foo', doc: 'data.ttl' } }))

    expect(res.status).toBe(422)
    expect(mockCommitFileOnBranch).not.toHaveBeenCalled()
  })

  it('returns 422 on malformed body', async () => {
    mockFetchFileFromGitHub.mockResolvedValueOnce({
      status: 404,
      body: textBody(''),
      contentType: null,
      etag: null,
      cacheControl: null
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/draft/data.ttl', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'text/n3',
        authorization: 'DPoP token',
        dpop: 'dpop'
      },
      body: 'this is not valid n3'
    })
    const res = await handler(req, makeContext({ params: { page: 'foo', doc: 'data.ttl' } }))

    expect(res.status).toBe(422)
    expect(mockCommitFileOnBranch).not.toHaveBeenCalled()
  })

  it('returns 400 when the path is unsafe', async () => {
    mockIsPathSafe.mockReturnValueOnce(false)

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/draft/..%2Fsecret.ttl', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'text/n3',
        authorization: 'DPoP token',
        dpop: 'dpop'
      },
      body: patchBody('ex:a ex:p ex:b .')
    })
    const res = await handler(req, makeContext({ params: { page: 'foo', doc: '../secret.ttl' } }))

    expect(res.status).toBe(400)
    expect(mockCommitFileOnBranch).not.toHaveBeenCalled()
  })

  it('returns 200 with commit info when applying an insert-only patch to a missing .ttl file', async () => {
    mockFetchFileFromGitHub.mockResolvedValueOnce({
      status: 404,
      body: textBody(''),
      contentType: null,
      etag: null,
      cacheControl: null
    })
    mockCommitFileOnBranch.mockResolvedValueOnce({
      commitSha: 'commit-sha',
      htmlUrl: 'https://github.com/octocat/hello-world/commit/abc',
      branch: 'foo-draft',
      contentSha: 'new-blob'
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/draft/data.ttl', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'text/n3',
        authorization: 'DPoP token',
        dpop: 'dpop'
      },
      body: patchBody('ex:alice ex:knows ex:bob .')
    })
    const res = await handler(req, makeContext({ params: { page: 'foo', doc: 'data.ttl' } }))

    expect(res.status).toBe(200)
    expect(res.headers.get('ETag')).toBe('"new-blob"')
    expect(res.headers.get('Content-Type')).toContain('application/json')
    const body = await res.json()
    expect(body.commit).toBe('commit-sha')
    expect(body.branch).toBe('foo-draft')
    expect(body.path).toBe('foo/data.ttl')
  })

  it('fetches the existing file from the draft branch and commits the merged turtle', async () => {
    const existing = `${PREFIXES}ex:alice ex:knows ex:carol .\n`
    mockFetchFileFromGitHub.mockResolvedValueOnce({
      status: 200,
      body: textBody(existing),
      contentType: 'text/turtle; charset=utf-8',
      etag: 'W/"existing"',
      cacheControl: null
    })
    mockCommitFileOnBranch.mockResolvedValueOnce({
      commitSha: 'c',
      htmlUrl: 'u',
      branch: 'foo-draft',
      contentSha: 'merged-blob'
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/draft/data.ttl', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'text/n3',
        authorization: 'DPoP token',
        dpop: 'dpop'
      },
      body: patchBody('ex:alice ex:knows ex:bob .')
    })
    await handler(req, makeContext({ params: { page: 'foo', doc: 'data.ttl' } }))

    expect(mockFetchFileFromGitHub).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'foo/data.ttl', ref: 'foo-draft' })
    )
    expect(mockCommitFileOnBranch).toHaveBeenCalledTimes(1)
    const committed = mockCommitFileOnBranch.mock.calls[0][0]
    expect(committed.branch).toBe('foo-draft')
    expect(committed.path).toBe('foo/data.ttl')
    // content is base64; decode and check both triples are present
    const decoded = Buffer.from(committed.content, 'base64').toString('utf-8')
    expect(decoded).toContain('ex:alice')
    expect(decoded).toContain('ex:carol')
    expect(decoded).toContain('ex:bob')
  })

  it('forwards If-Match to commitFileOnBranch', async () => {
    mockFetchFileFromGitHub.mockResolvedValueOnce({
      status: 404,
      body: textBody(''),
      contentType: null,
      etag: null,
      cacheControl: null
    })
    mockCommitFileOnBranch.mockResolvedValueOnce({
      commitSha: 'c',
      htmlUrl: 'u',
      branch: 'foo-draft',
      contentSha: 'merged-blob'
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/draft/data.ttl', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'text/n3',
        authorization: 'DPoP token',
        dpop: 'dpop',
        'If-Match': 'W/"stale"'
      },
      body: patchBody('ex:a ex:p ex:b .')
    })
    await handler(req, makeContext({ params: { page: 'foo', doc: 'data.ttl' } }))

    expect(mockCommitFileOnBranch).toHaveBeenCalledWith(
      expect.objectContaining({ ifMatch: 'stale' })
    )
  })

  it('returns 412 when commitFileOnBranch rejects with 409 (sha mismatch)', async () => {
    const { GitHubApiError } = await import('../../src/github.js')
    mockFetchFileFromGitHub.mockResolvedValueOnce({
      status: 404,
      body: textBody(''),
      contentType: null,
      etag: null,
      cacheControl: null
    })
    mockCommitFileOnBranch.mockRejectedValueOnce(
      new GitHubApiError('does not match', 409)
    )

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/draft/data.ttl', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'text/n3',
        authorization: 'DPoP token',
        dpop: 'dpop',
        'If-Match': 'W/"stale"'
      },
      body: patchBody('ex:a ex:p ex:b .')
    })
    const res = await handler(req, makeContext({ params: { page: 'foo', doc: 'data.ttl' } }))

    expect(res.status).toBe(412)
  })

  it('returns 502 on GitHub upstream errors from commitFileOnBranch', async () => {
    const { GitHubApiError } = await import('../../src/github.js')
    mockFetchFileFromGitHub.mockResolvedValueOnce({
      status: 404,
      body: textBody(''),
      contentType: null,
      etag: null,
      cacheControl: null
    })
    mockCommitFileOnBranch.mockRejectedValueOnce(
      new GitHubApiError('upstream down', 502)
    )

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/draft/data.ttl', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'text/n3',
        authorization: 'DPoP token',
        dpop: 'dpop'
      },
      body: patchBody('ex:a ex:p ex:b .')
    })
    const res = await handler(req, makeContext({ params: { page: 'foo', doc: 'data.ttl' } }))

    expect(res.status).toBe(502)
  })

  it('returns 502 on GitHub upstream errors from fetchFileFromGitHub', async () => {
    mockFetchFileFromGitHub.mockRejectedValueOnce(new Error('fetch failed'))

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/draft/data.ttl', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'text/n3',
        authorization: 'DPoP token',
        dpop: 'dpop'
      },
      body: patchBody('ex:a ex:p ex:b .')
    })
    const res = await handler(req, makeContext({ params: { page: 'foo', doc: 'data.ttl' } }))

    expect(res.status).toBe(502)
  })

  it('passes PATCH as the expected method to verifyDpopToken', async () => {
    mockFetchFileFromGitHub.mockResolvedValueOnce({
      status: 404,
      body: textBody(''),
      contentType: null,
      etag: null,
      cacheControl: null
    })
    mockCommitFileOnBranch.mockResolvedValueOnce({
      commitSha: 'c',
      htmlUrl: 'u',
      branch: 'foo-draft',
      contentSha: 'merged-blob'
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/draft/data.ttl', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'text/n3',
        authorization: 'DPoP token',
        dpop: 'dpop'
      },
      body: patchBody('ex:a ex:p ex:b .')
    })
    await handler(req, makeContext({ params: { page: 'foo', doc: 'data.ttl' } }))

    expect(mockVerifyDpopToken).toHaveBeenCalledWith(
      'DPoP token',
      'dpop',
      expect.any(String),
      'PATCH',
      ['https://alice.example/webid#me']
    )
  })

  it('returns the new blob SHA as the ETag header on a successful PATCH', async () => {
    mockFetchFileFromGitHub.mockResolvedValueOnce({
      status: 404,
      body: textBody(''),
      contentType: null,
      etag: null,
      cacheControl: null
    })
    mockCommitFileOnBranch.mockResolvedValueOnce({
      commitSha: 'commit-sha',
      htmlUrl: 'https://example/commit',
      branch: 'foo-draft',
      contentSha: 'new-blob-sha'
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/draft/data.ttl', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'text/n3',
        authorization: 'DPoP token',
        dpop: 'dpop'
      },
      body: patchBody('ex:a ex:p ex:b .')
    })
    const res = await handler(req, makeContext({ params: { page: 'foo', doc: 'data.ttl' } }))

    expect(res.status).toBe(200)
    expect(res.headers.get('ETag')).toBe('"new-blob-sha"')
  })
})

describe('router CORS preflight advertises If-Match', () => {
  it('includes If-Match in Access-Control-Allow-Headers on OPTIONS', async () => {
    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/bar', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://example.com',
        'Access-Control-Request-Method': 'PUT',
        'Access-Control-Request-Headers': 'If-Match'
      }
    })
    const res = await handler(req, makeContext())

    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('If-Match')
  })
})

describe('router PUT conditional requests with If-Match', () => {
  beforeEach(() => {
    mockCommitFileOnBranch.mockReset()
    mockIsPathSafe.mockReset()
    mockIsPathSafe.mockReturnValue(true)
    mockGetFileBlobSha.mockReset()
    mockGetFileBlobSha.mockResolvedValue(null)
    mockLoadGithubConfig.mockReturnValue({
      githubRepo: 'octocat/hello-world',
      githubToken: 'ghp_test',
      githubRef: 'HEAD'
    })
  })

  it('forwards a weak ETag If-Match to commitFileOnBranch as the blob SHA', async () => {
    mockCommitFileOnBranch.mockResolvedValueOnce({
      commitSha: 'c',
      htmlUrl: 'u',
      branch: 'foo-draft',
      contentSha: 'abc'
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/draft/bar', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        authorization: 'DPoP token',
        dpop: 'dpop',
        'If-Match': 'W/"abc"'
      },
      body: '{}'
    })
    await handler(req, makeContext({ params: { page: 'foo', doc: 'bar' } }))

    expect(mockCommitFileOnBranch).toHaveBeenCalledWith(
      expect.objectContaining({ ifMatch: 'abc' })
    )
  })

  it('forwards a strong ETag If-Match to commitFileOnBranch as the blob SHA', async () => {
    mockCommitFileOnBranch.mockResolvedValueOnce({
      commitSha: 'c',
      htmlUrl: 'u',
      branch: 'foo-draft',
      contentSha: 'def'
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/draft/bar', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        authorization: 'DPoP token',
        dpop: 'dpop',
        'If-Match': '"def"'
      },
      body: '{}'
    })
    await handler(req, makeContext({ params: { page: 'foo', doc: 'bar' } }))

    expect(mockCommitFileOnBranch).toHaveBeenCalledWith(
      expect.objectContaining({ ifMatch: 'def' })
    )
  })

  it('proceeds with the commit when If-None-Match: * and the file does not exist on the draft branch', async () => {
    mockCommitFileOnBranch.mockResolvedValueOnce({
      commitSha: 'c',
      htmlUrl: 'u',
      branch: 'foo-draft',
      contentSha: 'ghi'
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/draft/bar', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        authorization: 'DPoP token',
        dpop: 'dpop',
        'If-None-Match': '*'
      },
      body: '{}'
    })
    const res = await handler(req, makeContext({ params: { page: 'foo', doc: 'bar' } }))

    expect(res.status).toBe(200)
    expect(mockCommitFileOnBranch).toHaveBeenCalled()
  })

  it('returns the new blob SHA as the ETag header on a successful PUT', async () => {
    mockCommitFileOnBranch.mockResolvedValueOnce({
      commitSha: 'commit-sha',
      htmlUrl: 'https://example/commit',
      branch: 'foo-draft',
      contentSha: 'new-blob-sha'
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/draft/bar', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        authorization: 'DPoP token',
        dpop: 'dpop'
      },
      body: '{}'
    })
    const res = await handler(req, makeContext({ params: { page: 'foo', doc: 'bar' } }))

    expect(res.status).toBe(200)
    expect(res.headers.get('ETag')).toBe('"new-blob-sha"')
  })

  it('returns 412 Precondition Failed when commitFileOnBranch rejects with 409', async () => {
    const { GitHubApiError } = await import('../../src/github.js')
    mockCommitFileOnBranch.mockRejectedValueOnce(
      new GitHubApiError('does not match', 409)
    )

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/draft/bar', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        authorization: 'DPoP token',
        dpop: 'dpop',
        'If-Match': 'W/"stale"'
      },
      body: '{}'
    })
    const res = await handler(req, makeContext({ params: { page: 'foo', doc: 'bar' } }))

    expect(res.status).toBe(412)
  })

  it('returns 412 Precondition Failed when commitFileOnBranch rejects with 422 SHA mismatch', async () => {
    const { GitHubApiError } = await import('../../src/github.js')
    mockCommitFileOnBranch.mockRejectedValueOnce(
      new GitHubApiError('sha does not match', 422)
    )

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/draft/bar', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        authorization: 'DPoP token',
        dpop: 'dpop',
        'If-Match': 'W/"stale"'
      },
      body: '{}'
    })
    const res = await handler(req, makeContext({ params: { page: 'foo', doc: 'bar' } }))

    expect(res.status).toBe(412)
  })

  it('attaches CORS headers to the 412 Precondition Failed response', async () => {
    const { GitHubApiError } = await import('../../src/github.js')
    mockCommitFileOnBranch.mockRejectedValueOnce(
      new GitHubApiError('does not match', 409)
    )

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/draft/bar', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        authorization: 'DPoP token',
        dpop: 'dpop',
        'If-Match': 'W/"stale"',
        Origin: 'https://example.com'
      },
      body: '{}'
    })
    const res = await handler(req, makeContext({ params: { page: 'foo', doc: 'bar' } }))

    expect(res.status).toBe(412)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://example.com')
    expect(res.headers.get('Access-Control-Expose-Headers')).toContain('ETag')
  })

  it('returns 400 when both If-Match and If-None-Match: * are present', async () => {
    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/draft/bar', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        authorization: 'DPoP token',
        dpop: 'dpop',
        'If-Match': 'W/"abc"',
        'If-None-Match': '*'
      },
      body: '{}'
    })
    const res = await handler(req, makeContext({ params: { page: 'foo', doc: 'bar' } }))

    expect(res.status).toBe(400)
    expect(mockCommitFileOnBranch).not.toHaveBeenCalled()
  })

  it('returns 412 Precondition Failed when If-None-Match: * and the file exists on the draft branch', async () => {
    mockGetFileBlobSha.mockResolvedValueOnce('existing-blob-sha')

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/draft/bar', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        authorization: 'DPoP token',
        dpop: 'dpop',
        'If-None-Match': '*'
      },
      body: '{}'
    })
    const res = await handler(req, makeContext({ params: { page: 'foo', doc: 'bar' } }))

    expect(res.status).toBe(412)
    expect(mockCommitFileOnBranch).not.toHaveBeenCalled()
  })
})

describe('router GET Vary header', () => {
  beforeEach(() => {
    mockFetchFileFromGitHub.mockReset()
    mockIsPathSafe.mockReset()
    mockIsPathSafe.mockReturnValue(true)
    mockLoadGithubConfig.mockReturnValue({
      githubRepo: 'octocat/hello-world',
      githubToken: 'ghp_test',
      githubRef: 'HEAD'
    })
  })

  function textBody(text: string): Uint8Array {
    return new TextEncoder().encode(text)
  }

  it('includes Vary: If-None-Match on a 304 GET response', async () => {
    mockFetchFileFromGitHub.mockResolvedValueOnce({
      status: 304,
      body: textBody(''),
      contentType: null,
      etag: 'W/"abc"',
      cacheControl: null
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/bar', {
      method: 'GET',
      headers: { 'If-None-Match': 'W/"abc"' }
    })
    const res = await handler(req, makeContext({ params: { page: 'foo', doc: 'bar' } }))

    expect(res.status).toBe(304)
    expect(res.headers.get('Vary')).toContain('If-None-Match')
  })

  it('includes Vary: If-None-Match on a 200 GET response when the client sent If-None-Match', async () => {
    mockFetchFileFromGitHub.mockResolvedValueOnce({
      status: 200,
      body: textBody('ok'),
      contentType: 'text/plain',
      etag: 'W/"abc"',
      cacheControl: null
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/bar', {
      method: 'GET',
      headers: { 'If-None-Match': 'W/"stale"' }
    })
    const res = await handler(req, makeContext({ params: { page: 'foo', doc: 'bar' } }))

    expect(res.status).toBe(200)
    expect(res.headers.get('Vary')).toContain('If-None-Match')
  })
})

describe('router GET container listing', () => {
  beforeEach(() => {
    mockFetchFileFromGitHub.mockReset()
    mockListDirectoryFromGitHub.mockReset()
    mockIsPathSafe.mockReset()
    mockIsPathSafe.mockReturnValue(true)
    mockLoadGithubConfig.mockReturnValue({
      githubRepo: 'octocat/hello-world',
      githubToken: 'ghp_test',
      githubRef: 'HEAD'
    })
    mockVerifyDpopToken.mockReset()
    mockLoadWriteConfig.mockReturnValue({ writeWebIds: [] as string[] })
  })

  it('serves GET / as a Turtle container listing for the repo root', async () => {
    mockListDirectoryFromGitHub.mockResolvedValueOnce({
      status: 200,
      entries: [
        { name: 'README.md', path: 'README.md', type: 'file', sha: 'sha-r' },
        { name: 'foo', path: 'foo', type: 'dir', sha: 'sha-f' }
      ]
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/', { method: 'GET' })
    const res = await handler(req, makeContext({ params: {} }))

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/turtle; charset=utf-8')
    const body = await res.text()
    expect(body).toContain('@prefix ldp: <http://www.w3.org/ns/ldp#> .')
    expect(body).toMatch(/<>\s+a\s+ldp:Container,\s+ldp:BasicContainer/)
    expect(body).toContain('<README.md> a ldp:Resource .')
    expect(body).toMatch(/<foo\/>\s+a\s+ldp:Container,\s+ldp:BasicContainer/)
    expect(mockListDirectoryFromGitHub).toHaveBeenCalledWith(
      expect.objectContaining({ path: '', ref: 'HEAD' })
    )
  })

  it('serves GET /foo/ as a Turtle listing for the foo directory', async () => {
    mockListDirectoryFromGitHub.mockResolvedValueOnce({
      status: 200,
      entries: [{ name: 'bar.txt', path: 'foo/bar.txt', type: 'file', sha: 'sha-b' }]
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/', { method: 'GET' })
    const res = await handler(req, makeContext({ params: { page: 'foo' } }))

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/turtle; charset=utf-8')
    expect(mockListDirectoryFromGitHub).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'foo', ref: 'HEAD' })
    )
    const body = await res.text()
    expect(body).toContain('<bar.txt> a ldp:Resource .')
  })

  it('serves nested container paths like /blog/04/ as Turtle', async () => {
    mockListDirectoryFromGitHub.mockResolvedValueOnce({
      status: 200,
      entries: []
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/blog/04/', { method: 'GET' })
    await handler(req, makeContext({ params: { page: 'blog/04' } }))

    expect(mockListDirectoryFromGitHub).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'blog/04', ref: 'HEAD' })
    )
  })

  it('serves GET /foo/history/draft/ as a Turtle listing for the foo-draft branch', async () => {
    mockListDirectoryFromGitHub.mockResolvedValueOnce({
      status: 200,
      entries: [{ name: 'bar.txt', path: 'foo/bar.txt', type: 'file', sha: 'sha-d' }]
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/draft/', { method: 'GET' })
    const res = await handler(req, makeContext({ params: { page: 'foo' } }))

    expect(res.status).toBe(200)
    expect(mockListDirectoryFromGitHub).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'foo', ref: 'foo-draft' })
    )
    expect(res.headers.get('WAC-Allow')).toBe('user="read", public="read"')
  })

  it('uses the effective page URI (stripped of /history/draft/) as the Turtle subject on draft containers', async () => {
    mockListDirectoryFromGitHub.mockResolvedValueOnce({
      status: 200,
      entries: [{ name: 'bar.txt', path: 'foo/bar.txt', type: 'file', sha: 'sha-d' }]
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/draft/', { method: 'GET' })
    const res = await handler(req, makeContext({ params: { page: 'foo' } }))

    const body = await res.text()
    expect(body).not.toMatch(/<>\s+a\s+ldp:Container,\s+ldp:BasicContainer[^.]*<\/foo\/history\/draft\/>\s*a/m)
    expect(body).toMatch(/<>\s+a\s+ldp:Container,\s+ldp:BasicContainer[^.]*<bar\.txt>/)
    expect(body).not.toContain('<foo/bar.txt>')
  })

  it('regression: /blog/history/draft/ lists children with the page prefix stripped (deployed-preview bug)', async () => {
    mockListDirectoryFromGitHub.mockResolvedValueOnce({
      status: 200,
      entries: [
        { name: '01', path: 'blog/01', type: 'dir', sha: 'sha-1' },
        { name: '02', path: 'blog/02', type: 'dir', sha: 'sha-2' },
        { name: '03', path: 'blog/03', type: 'dir', sha: 'sha-3' },
        { name: '04', path: 'blog/04', type: 'dir', sha: 'sha-4' },
        { name: '05', path: 'blog/05', type: 'dir', sha: 'sha-5' },
        { name: 'home.html', path: 'blog/home.html', type: 'file', sha: 'sha-h' }
      ]
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/blog/history/draft/', { method: 'GET' })
    const res = await handler(req, makeContext({ params: { page: 'blog/history' } }))

    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('<01/> a ldp:Container, ldp:BasicContainer .')
    expect(body).toContain('<02/> a ldp:Container, ldp:BasicContainer .')
    expect(body).toContain('<03/> a ldp:Container, ldp:BasicContainer .')
    expect(body).toContain('<04/> a ldp:Container, ldp:BasicContainer .')
    expect(body).toContain('<05/> a ldp:Container, ldp:BasicContainer .')
    expect(body).toContain('<home.html> a ldp:Resource .')
    expect(body).not.toContain('<blog/01/>')
    expect(body).not.toContain('<blog/home.html>')
  })

  it('falls back to GITHUB_REF on a 404 draft container listing', async () => {
    mockListDirectoryFromGitHub
      .mockResolvedValueOnce({ status: 404, entries: [] })
      .mockResolvedValueOnce({
        status: 200,
        entries: [{ name: 'bar.txt', path: 'foo/bar.txt', type: 'file', sha: 'sha-m' }]
      })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/draft/', { method: 'GET' })
    const res = await handler(req, makeContext({ params: { page: 'foo' } }))

    expect(res.status).toBe(200)
    expect(mockListDirectoryFromGitHub).toHaveBeenCalledTimes(2)
    expect(mockListDirectoryFromGitHub.mock.calls[0][0]).toEqual(
      expect.objectContaining({ ref: 'foo-draft', path: 'foo' })
    )
    expect(mockListDirectoryFromGitHub.mock.calls[1][0]).toEqual(
      expect.objectContaining({ ref: 'HEAD', path: 'foo' })
    )
    expect(res.headers.get('WAC-Allow')).toBe('user="read", public="read"')
  })

  it('emits WAC-Allow with user="read write" on draft containers for an authenticated allowlisted WebID', async () => {
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
    mockLoadWriteConfig.mockReturnValue({ writeWebIds: ['https://alice.example/webid#me'] })
    mockListDirectoryFromGitHub.mockResolvedValueOnce({
      status: 200,
      entries: []
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/draft/', {
      method: 'GET',
      headers: {
        authorization: 'DPoP token',
        dpop: 'dpop-proof'
      }
    })
    const res = await handler(req, makeContext({ params: { page: 'foo' } }))

    expect(res.status).toBe(200)
    expect(res.headers.get('WAC-Allow')).toBe('user="read write", public="read"')
  })

  it('omits WAC-Allow on the published container route', async () => {
    mockListDirectoryFromGitHub.mockResolvedValueOnce({ status: 200, entries: [] })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/', { method: 'GET' })
    const res = await handler(req, makeContext({ params: { page: 'foo' } }))

    expect(res.status).toBe(200)
    expect(res.headers.get('WAC-Allow')).toBeNull()
  })

  it('returns 404 when both the draft and main listings miss', async () => {
    mockListDirectoryFromGitHub
      .mockResolvedValueOnce({ status: 404, entries: [] })
      .mockResolvedValueOnce({ status: 404, entries: [] })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/draft/', { method: 'GET' })
    const res = await handler(req, makeContext({ params: { page: 'foo' } }))

    expect(res.status).toBe(404)
    expect(mockListDirectoryFromGitHub).toHaveBeenCalledTimes(2)
  })

  it('returns 502 when the upstream listing throws', async () => {
    mockListDirectoryFromGitHub.mockRejectedValueOnce(new Error('upstream down'))

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/', { method: 'GET' })
    const res = await handler(req, makeContext({ params: { page: 'foo' } }))

    expect(res.status).toBe(502)
    expect(await res.text()).toBe('upstream down')
  })

  it('returns 502 on a GitHubFetchError from the listing', async () => {
    const { GitHubFetchError } = await import('../../src/github.js')
    mockListDirectoryFromGitHub.mockRejectedValueOnce(new GitHubFetchError('boom', 502))

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/', { method: 'GET' })
    const res = await handler(req, makeContext({ params: {} }))

    expect(res.status).toBe(502)
  })

  it('returns 400 when the assembled container path is unsafe', async () => {
    mockIsPathSafe.mockReturnValueOnce(false)

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo%2F..%2F/', { method: 'GET' })
    const res = await handler(req, makeContext({ params: { page: 'foo/..' } }))

    expect(res.status).toBe(400)
    expect(mockListDirectoryFromGitHub).not.toHaveBeenCalled()
  })

  it('returns 405 for PUT on a container path (not under /history/draft/:doc)', async () => {
    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        authorization: 'DPoP token',
        dpop: 'dpop'
      },
      body: '{}'
    })
    const res = await handler(req, makeContext({ params: { page: 'foo' } }))

    expect(res.status).toBe(405)
    expect(mockCommitFileOnBranch).not.toHaveBeenCalled()
  })

  it('includes Vary: If-None-Match on a container GET when the client sent If-None-Match', async () => {
    mockListDirectoryFromGitHub.mockResolvedValueOnce({ status: 200, entries: [] })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/', {
      method: 'GET',
      headers: { 'If-None-Match': 'W/"abc"' }
    })
    const res = await handler(req, makeContext({ params: { page: 'foo' } }))

    expect(res.headers.get('Vary')).toContain('If-None-Match')
  })

  it('attaches CORS headers to the container response', async () => {
    mockListDirectoryFromGitHub.mockResolvedValueOnce({ status: 200, entries: [] })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/', {
      method: 'GET',
      headers: { Origin: 'https://example.com' }
    })
    const res = await handler(req, makeContext({ params: { page: 'foo' } }))

    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://example.com')
    expect(res.headers.get('Vary')).toContain('Origin')
  })
})

describe('router history root', () => {
  beforeEach(() => {
    mockFetchFileFromGitHub.mockReset()
    mockListDirectoryFromGitHub.mockReset()
    mockIsPathSafe.mockReset()
    mockIsPathSafe.mockReturnValue(true)
    mockCommitFileOnBranch.mockReset()
    mockGetFileBlobSha.mockReset()
    mockLoadGithubConfig.mockReturnValue({
      githubRepo: 'octocat/hello-world',
      githubToken: 'ghp_test',
      githubRef: 'HEAD'
    })
  })

  it('adds a /:page*/history/:rest* catch-all path matcher', async () => {
    const { config } = await import('../../netlify/functions/router/router.mts')
    expect(config.path).toContain('/:page*/history/:rest*')
  })

  it('GET /foo/history with Accept: text/turtle returns an LDP BasicContainer listing years', async () => {
    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history', {
      method: 'GET',
      headers: { Accept: 'text/turtle' }
    })
    const res = await handler(
      req,
      makeContext({ params: { page: 'foo', rest: '' } })
    )

    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('ldp:BasicContainer')
    expect(body).toMatch(/ldp:contains/)
  })

  it('lists years from REPO_START_YEAR through currentYear as ldp:contains children', async () => {
    const currentYear = new Date().getUTCFullYear()
    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history', {
      method: 'GET',
      headers: { Accept: 'text/turtle' }
    })
    const res = await handler(
      req,
      makeContext({ params: { page: 'foo', rest: '' } })
    )

    const body = await res.text()
    expect(body).toContain(`<${currentYear}/>`)
  })

  it('emits a 1-day max-age Cache-Control header', async () => {
    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history', { method: 'GET' })
    const res = await handler(
      req,
      makeContext({ params: { page: 'foo', rest: '' } })
    )

    expect(res.status).toBe(200)
    const cacheControl = res.headers.get('Cache-Control') ?? ''
    expect(cacheControl).toMatch(/max-age=86400/)
  })

  it('makes zero GitHub API calls for the history root', async () => {
    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history', { method: 'GET' })
    await handler(req, makeContext({ params: { page: 'foo', rest: '' } }))

    expect(mockListDirectoryFromGitHub).not.toHaveBeenCalled()
    expect(mockFetchFileFromGitHub).not.toHaveBeenCalled()
  })

  it('GET /foo/history with Accept: text/html returns an HTML container', async () => {
    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history', {
      method: 'GET',
      headers: { Accept: 'text/html' }
    })
    const res = await handler(
      req,
      makeContext({ params: { page: 'foo', rest: '' } })
    )

    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toMatch(/<!doctype html>/i)
    expect(body).toMatch(/<ul>/)
  })

  it('GET /foo/history/draft (no doc) returns 404', async () => {
    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/draft', { method: 'GET' })
    const res = await handler(
      req,
      makeContext({ params: { page: 'foo', rest: 'draft' } })
    )

    expect(res.status).toBe(404)
  })

  it('declares the history catch-all AFTER the draft path so draft paths still match the existing draft handler', async () => {
    const { config } = await import('../../netlify/functions/router/router.mts')
    const draftIdx = config.path.indexOf('/:page*/history/draft/:doc*')
    const catchAllIdx = config.path.indexOf('/:page*/history/:rest*')
    expect(draftIdx).toBeGreaterThanOrEqual(0)
    expect(catchAllIdx).toBeGreaterThanOrEqual(0)
    expect(draftIdx).toBeLessThan(catchAllIdx)
  })
})

describe('router year/month containers', () => {
  beforeEach(() => {
    mockFetchFileFromGitHub.mockReset()
    mockListDirectoryFromGitHub.mockReset()
    mockListCommitsForPath.mockReset()
    mockIsPathSafe.mockReset()
    mockIsPathSafe.mockReturnValue(true)
    mockCommitFileOnBranch.mockReset()
    mockGetFileBlobSha.mockReset()
    mockLoadGithubConfig.mockReturnValue({
      githubRepo: 'octocat/hello-world',
      githubToken: 'ghp_test',
      githubRef: 'HEAD'
    })
  })

  it('GET /foo/history/2026 (in range) calls listCommitsForPath with since/until for the year', async () => {
    mockListCommitsForPath.mockResolvedValueOnce([])

    const { default: handler } = await import(
      '../../netlify/functions/router/router.mts'
    )
    const req = new Request('http://localhost/foo/history/2026', {
      method: 'GET',
      headers: { Accept: 'text/turtle' }
    })
    const res = await handler(
      req,
      makeContext({ params: { page: 'foo', rest: '2026' } })
    )

    expect(res.status).toBe(200)
    expect(mockListCommitsForPath).toHaveBeenCalledTimes(1)
    const args = mockListCommitsForPath.mock.calls[0][0]
    expect(args.branch).toBe('HEAD')
    expect(args.path).toBe('foo')
    expect(args.since).toBe('2026-01-01T00:00:00Z')
    expect(args.until).toBe('2026-12-31T23:59:59Z')
  })

  it('GET /foo/history/2026 emits an LDP container of MM/ children for months with commits', async () => {
    mockListCommitsForPath.mockResolvedValueOnce([
      {
        sha: 'a1',
        message: 'Jan commit',
        authorName: 'Alice',
        authorEmail: 'a@x',
        date: '2026-01-15T10:00:00Z',
        htmlUrl: 'https://example/commit/a1'
      },
      {
        sha: 'b2',
        message: 'Aug commit',
        authorName: 'Bob',
        authorEmail: 'b@x',
        date: '2026-08-22T12:00:00Z',
        htmlUrl: 'https://example/commit/b2'
      }
    ] as any)

    const { default: handler } = await import(
      '../../netlify/functions/router/router.mts'
    )
    const req = new Request('http://localhost/foo/history/2026', {
      method: 'GET',
      headers: { Accept: 'text/turtle' }
    })
    const res = await handler(
      req,
      makeContext({ params: { page: 'foo', rest: '2026' } })
    )

    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('<01/>')
    expect(body).toContain('<08/>')
    expect(body).not.toContain('<02/>')
  })

  it('GET /foo/history/2026 with no commits returns an empty LDP container (200 with empty ldp:contains)', async () => {
    mockListCommitsForPath.mockResolvedValueOnce([])

    const { default: handler } = await import(
      '../../netlify/functions/router/router.mts'
    )
    const req = new Request('http://localhost/foo/history/2026', {
      method: 'GET',
      headers: { Accept: 'text/turtle' }
    })
    const res = await handler(
      req,
      makeContext({ params: { page: 'foo', rest: '2026' } })
    )

    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toMatch(/ldp:contains\s*\./)
  })

  it('GET /foo/history/2026/08 calls listCommitsForPath with since/until for that month', async () => {
    mockListCommitsForPath.mockResolvedValueOnce([])

    const { default: handler } = await import(
      '../../netlify/functions/router/router.mts'
    )
    const req = new Request('http://localhost/foo/history/2026/08', {
      method: 'GET',
      headers: { Accept: 'text/turtle' }
    })
    const res = await handler(
      req,
      makeContext({ params: { page: 'foo', rest: '2026/08' } })
    )

    expect(res.status).toBe(200)
    const args = mockListCommitsForPath.mock.calls[0][0]
    expect(args.since).toBe('2026-08-01T00:00:00Z')
    expect(args.until).toBe('2026-08-31T23:59:59Z')
  })

  it('GET /foo/history/2026/08 emits ldp:contains of <shortSha>/ for each commit in that month', async () => {
    mockListCommitsForPath.mockResolvedValueOnce([
      {
        sha: 'abc1234567890',
        message: 'Aug 1',
        authorName: 'Alice',
        authorEmail: 'a@x',
        date: '2026-08-01T10:00:00Z',
        htmlUrl: 'https://example/commit/abc1234567890'
      },
      {
        sha: 'def6789012345',
        message: 'Aug 22',
        authorName: 'Bob',
        authorEmail: 'b@x',
        date: '2026-08-22T12:00:00Z',
        htmlUrl: 'https://example/commit/def6789012345'
      }
    ] as any)

    const { default: handler } = await import(
      '../../netlify/functions/router/router.mts'
    )
    const req = new Request('http://localhost/foo/history/2026/08', {
      method: 'GET',
      headers: { Accept: 'text/turtle' }
    })
    const res = await handler(
      req,
      makeContext({ params: { page: 'foo', rest: '2026/08' } })
    )

    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('<abc1234/>')
    expect(body).toContain('<def6789/>')
  })

  it('GET /foo/history/2026/08 with no commits returns 200 empty container', async () => {
    mockListCommitsForPath.mockResolvedValueOnce([])

    const { default: handler } = await import(
      '../../netlify/functions/router/router.mts'
    )
    const req = new Request('http://localhost/foo/history/2026/08', {
      method: 'GET',
      headers: { Accept: 'text/turtle' }
    })
    const res = await handler(
      req,
      makeContext({ params: { page: 'foo', rest: '2026/08' } })
    )

    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toMatch(/ldp:contains\s*\./)
  })

  it('year and month containers set Cache-Control max-age=86400', async () => {
    mockListCommitsForPath.mockResolvedValueOnce([]).mockResolvedValueOnce([])
    const { default: handler } = await import(
      '../../netlify/functions/router/router.mts'
    )

    const yearReq = new Request('http://localhost/foo/history/2026', {
      method: 'GET'
    })
    const yearRes = await handler(
      yearReq,
      makeContext({ params: { page: 'foo', rest: '2026' } })
    )
    expect(yearRes.headers.get('Cache-Control')).toMatch(/max-age=86400/)

    const monthReq = new Request('http://localhost/foo/history/2026/08', {
      method: 'GET'
    })
    const monthRes = await handler(
      monthReq,
      makeContext({ params: { page: 'foo', rest: '2026/08' } })
    )
    expect(monthRes.headers.get('Cache-Control')).toMatch(/max-age=86400/)
  })

  it('GET /foo/history/2026 with Accept: text/html returns an HTML container', async () => {
    mockListCommitsForPath.mockResolvedValueOnce([])
    const { default: handler } = await import(
      '../../netlify/functions/router/router.mts'
    )
    const req = new Request('http://localhost/foo/history/2026', {
      method: 'GET',
      headers: { Accept: 'text/html' }
    })
    const res = await handler(
      req,
      makeContext({ params: { page: 'foo', rest: '2026' } })
    )

    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toMatch(/<!doctype html>/i)
  })
})

describe('router commit folder', () => {
  beforeEach(() => {
    mockFetchFileFromGitHub.mockReset()
    mockListDirectoryFromGitHub.mockReset()
    mockListCommitsForPath.mockReset()
    mockIsPathSafe.mockReset()
    mockIsPathSafe.mockReturnValue(true)
    mockCommitFileOnBranch.mockReset()
    mockGetFileBlobSha.mockReset()
    mockLoadGithubConfig.mockReturnValue({
      githubRepo: 'octocat/hello-world',
      githubToken: 'ghp_test',
      githubRef: 'HEAD'
    })
  })

  it('GET /foo/history/<shortSha>/ calls listFolderContentsAtCommit with the SHA and the page folder', async () => {
    mockListDirectoryFromGitHub.mockResolvedValueOnce({
      status: 200,
      entries: [
        { name: 'index.html', path: 'foo/index.html', type: 'file', sha: 'sha-1' },
        { name: 'blog', path: 'foo/blog', type: 'dir', sha: 'sha-2' }
      ]
    })

    const { default: handler } = await import(
      '../../netlify/functions/router/router.mts'
    )
    const req = new Request('http://localhost/foo/history/abc1234', {
      method: 'GET',
      headers: { Accept: 'text/turtle' }
    })
    const res = await handler(
      req,
      makeContext({ params: { page: 'foo', rest: 'abc1234' } })
    )

    expect(res.status).toBe(200)
    expect(mockListDirectoryFromGitHub).toHaveBeenCalledTimes(1)
    const args = mockListDirectoryFromGitHub.mock.calls[0][0]
    expect(args.ref).toBe('abc1234')
    expect(args.path).toBe('foo')
  })

  it('emits an LDP container with the immediate children of the page at the commit', async () => {
    mockListDirectoryFromGitHub.mockResolvedValueOnce({
      status: 200,
      entries: [
        { name: 'index.html', path: 'foo/index.html', type: 'file', sha: 'sha-1' },
        { name: 'blog', path: 'foo/blog', type: 'dir', sha: 'sha-2' }
      ]
    })

    const { default: handler } = await import(
      '../../netlify/functions/router/router.mts'
    )
    const req = new Request('http://localhost/foo/history/abc1234', {
      method: 'GET',
      headers: { Accept: 'text/turtle' }
    })
    const res = await handler(
      req,
      makeContext({ params: { page: 'foo', rest: 'abc1234' } })
    )

    const body = await res.text()
    expect(body).toContain('<index.html>')
    expect(body).toContain('<blog/>')
  })

  it('emits an empty container (200 with empty ldp:contains) when the commit has no files for the page', async () => {
    mockListDirectoryFromGitHub.mockResolvedValueOnce({
      status: 200,
      entries: []
    })

    const { default: handler } = await import(
      '../../netlify/functions/router/router.mts'
    )
    const req = new Request('http://localhost/foo/history/abc1234', {
      method: 'GET',
      headers: { Accept: 'text/turtle' }
    })
    const res = await handler(
      req,
      makeContext({ params: { page: 'foo', rest: 'abc1234' } })
    )

    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toMatch(/ldp:contains\s*\./)
  })

  it('returns 404 when the page folder does not exist at the commit', async () => {
    mockListDirectoryFromGitHub.mockResolvedValueOnce({
      status: 404,
      entries: []
    })

    const { default: handler } = await import(
      '../../netlify/functions/router/router.mts'
    )
    const req = new Request('http://localhost/foo/history/abc1234', {
      method: 'GET',
      headers: { Accept: 'text/turtle' }
    })
    const res = await handler(
      req,
      makeContext({ params: { page: 'foo', rest: 'abc1234' } })
    )

    expect(res.status).toBe(404)
  })

  it('sets Cache-Control: public, max-age=31536000, immutable', async () => {
    mockListDirectoryFromGitHub.mockResolvedValueOnce({
      status: 200,
      entries: []
    })

    const { default: handler } = await import(
      '../../netlify/functions/router/router.mts'
    )
    const req = new Request('http://localhost/foo/history/abc1234', {
      method: 'GET'
    })
    const res = await handler(
      req,
      makeContext({ params: { page: 'foo', rest: 'abc1234' } })
    )

    expect(res.headers.get('Cache-Control')).toBe(
      'public, max-age=31536000, immutable'
    )
  })

  it('GET with Accept: text/html returns an HTML container', async () => {
    mockListDirectoryFromGitHub.mockResolvedValueOnce({
      status: 200,
      entries: [
        { name: 'index.html', path: 'foo/index.html', type: 'file', sha: 'sha-1' }
      ]
    })

    const { default: handler } = await import(
      '../../netlify/functions/router/router.mts'
    )
    const req = new Request('http://localhost/foo/history/abc1234', {
      method: 'GET',
      headers: { Accept: 'text/html' }
    })
    const res = await handler(
      req,
      makeContext({ params: { page: 'foo', rest: 'abc1234' } })
    )

    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toMatch(/<!doctype html>/i)
  })
})

describe('router commit file (SHA-robust)', () => {
  beforeEach(() => {
    mockFetchFileFromGitHub.mockReset()
    mockListDirectoryFromGitHub.mockReset()
    mockListCommitsForPath.mockReset()
    mockIsPathSafe.mockReset()
    mockIsPathSafe.mockReturnValue(true)
    mockCommitFileOnBranch.mockReset()
    mockGetFileBlobSha.mockReset()
    mockLoadGithubConfig.mockReturnValue({
      githubRepo: 'octocat/hello-world',
      githubToken: 'ghp_test',
      githubRef: 'HEAD'
    })
  })

  it('GET /foo/history/<shortSha>/foo.txt calls fetchFileFromGitHub with the SHA as ref and the file path', async () => {
    mockFetchFileFromGitHub.mockResolvedValueOnce({
      status: 200,
      body: new TextEncoder().encode('hello'),
      contentType: 'text/plain; charset=utf-8',
      etag: 'W/"abc"',
      cacheControl: null
    })

    const { default: handler } = await import(
      '../../netlify/functions/router/router.mts'
    )
    const req = new Request('http://localhost/foo/history/abc1234/foo.txt', {
      method: 'GET'
    })
    const res = await handler(
      req,
      makeContext({ params: { page: 'foo', rest: 'abc1234/foo.txt' } })
    )

    expect(res.status).toBe(200)
    expect(mockFetchFileFromGitHub).toHaveBeenCalledTimes(1)
    const args = mockFetchFileFromGitHub.mock.calls[0][0]
    expect(args.ref).toBe('abc1234')
    expect(args.path).toBe('foo/foo.txt')
  })

  it('returns the upstream file body, content-type, and ETag', async () => {
    mockFetchFileFromGitHub.mockResolvedValueOnce({
      status: 200,
      body: new TextEncoder().encode('hello'),
      contentType: 'text/plain; charset=utf-8',
      etag: 'W/"abc"',
      cacheControl: null
    })

    const { default: handler } = await import(
      '../../netlify/functions/router/router.mts'
    )
    const req = new Request('http://localhost/foo/history/abc1234/foo.txt', {
      method: 'GET'
    })
    const res = await handler(
      req,
      makeContext({ params: { page: 'foo', rest: 'abc1234/foo.txt' } })
    )

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('hello')
    expect(res.headers.get('Content-Type')).toBe('text/plain; charset=utf-8')
    expect(res.headers.get('ETag')).toBe('W/"abc"')
  })

  it('sets Cache-Control: public, max-age=31536000, immutable', async () => {
    mockFetchFileFromGitHub.mockResolvedValueOnce({
      status: 200,
      body: new TextEncoder().encode('hello'),
      contentType: 'text/plain; charset=utf-8',
      etag: 'W/"abc"',
      cacheControl: null
    })

    const { default: handler } = await import(
      '../../netlify/functions/router/router.mts'
    )
    const req = new Request('http://localhost/foo/history/abc1234/foo.txt', {
      method: 'GET'
    })
    const res = await handler(
      req,
      makeContext({ params: { page: 'foo', rest: 'abc1234/foo.txt' } })
    )

    expect(res.headers.get('Cache-Control')).toBe(
      'public, max-age=31536000, immutable'
    )
  })

  it('SHA is robust: a wrong year prefix is ignored, the SHA is what gets fetched', async () => {
    mockFetchFileFromGitHub.mockResolvedValueOnce({
      status: 200,
      body: new TextEncoder().encode('hello'),
      contentType: 'text/plain; charset=utf-8',
      etag: 'W/"abc"',
      cacheControl: null
    })

    const { default: handler } = await import(
      '../../netlify/functions/router/router.mts'
    )
    // /foo/history/2024/03/<shortSha>/foo.txt — the year and month are
    // bucket metadata, not data. The fetched ref is the shortSha, the
    // fetched path is foo/foo.txt. The "wrong" year/month are ignored.
    const req = new Request('http://localhost/foo/history/2024/03/abc1234/foo.txt', {
      method: 'GET'
    })
    const res = await handler(
      req,
      makeContext({ params: { page: 'foo', rest: '2024/03/abc1234/foo.txt' } })
    )

    expect(res.status).toBe(200)
    const args = mockFetchFileFromGitHub.mock.calls[0][0]
    expect(args.ref).toBe('abc1234')
    expect(args.path).toBe('foo/foo.txt')
  })

  it('SHA is robust: a year-only prefix is also ignored', async () => {
    mockFetchFileFromGitHub.mockResolvedValueOnce({
      status: 200,
      body: new TextEncoder().encode('hello'),
      contentType: 'text/plain; charset=utf-8',
      etag: 'W/"abc"',
      cacheControl: null
    })

    const { default: handler } = await import(
      '../../netlify/functions/router/router.mts'
    )
    const req = new Request('http://localhost/foo/history/2024/abc1234/foo.txt', {
      method: 'GET'
    })
    const res = await handler(
      req,
      makeContext({ params: { page: 'foo', rest: '2024/abc1234/foo.txt' } })
    )

    expect(res.status).toBe(200)
    const args = mockFetchFileFromGitHub.mock.calls[0][0]
    expect(args.ref).toBe('abc1234')
    expect(args.path).toBe('foo/foo.txt')
  })

  it('handles multi-segment doc paths (e.g. <shortSha>/sub/nested/file.md)', async () => {
    mockFetchFileFromGitHub.mockResolvedValueOnce({
      status: 200,
      body: new TextEncoder().encode('# Hi'),
      contentType: 'text/markdown; charset=utf-8',
      etag: 'W/"def"',
      cacheControl: null
    })

    const { default: handler } = await import(
      '../../netlify/functions/router/router.mts'
    )
    const req = new Request(
      'http://localhost/foo/history/abc1234/sub/nested/file.md',
      { method: 'GET' }
    )
    const res = await handler(
      req,
      makeContext({
        params: { page: 'foo', rest: 'abc1234/sub/nested/file.md' }
      })
    )

    expect(res.status).toBe(200)
    const args = mockFetchFileFromGitHub.mock.calls[0][0]
    expect(args.ref).toBe('abc1234')
    expect(args.path).toBe('foo/sub/nested/file.md')
  })

  it('returns 404 when GitHub reports a missing file', async () => {
    mockFetchFileFromGitHub.mockResolvedValueOnce({
      status: 404,
      body: new TextEncoder().encode('Not Found'),
      contentType: 'text/plain',
      etag: null,
      cacheControl: null
    })

    const { default: handler } = await import(
      '../../netlify/functions/router/router.mts'
    )
    const req = new Request('http://localhost/foo/history/abc1234/missing.txt', {
      method: 'GET'
    })
    const res = await handler(
      req,
      makeContext({ params: { page: 'foo', rest: 'abc1234/missing.txt' } })
    )

    expect(res.status).toBe(404)
  })

  it('forwards If-None-Match and returns 304 when the upstream returns 304', async () => {
    mockFetchFileFromGitHub.mockResolvedValueOnce({
      status: 304,
      body: new TextEncoder().encode(''),
      contentType: null,
      etag: 'W/"abc"',
      cacheControl: null
    })

    const { default: handler } = await import(
      '../../netlify/functions/router/router.mts'
    )
    const req = new Request('http://localhost/foo/history/abc1234/foo.txt', {
      method: 'GET',
      headers: { 'If-None-Match': 'W/"abc"' }
    })
    const res = await handler(
      req,
      makeContext({ params: { page: 'foo', rest: 'abc1234/foo.txt' } })
    )

    expect(res.status).toBe(304)
    expect(mockFetchFileFromGitHub.mock.calls[0][0].ifNoneMatch).toBe('W/"abc"')
  })
})

describe('router PUT rejection on commit-addressed URLs', () => {
  beforeEach(() => {
    mockFetchFileFromGitHub.mockReset()
    mockListDirectoryFromGitHub.mockReset()
    mockListCommitsForPath.mockReset()
    mockIsPathSafe.mockReset()
    mockIsPathSafe.mockReturnValue(true)
    mockCommitFileOnBranch.mockReset()
    mockGetFileBlobSha.mockReset()
    mockLoadGithubConfig.mockReturnValue({
      githubRepo: 'octocat/hello-world',
      githubToken: 'ghp_test',
      githubRef: 'HEAD'
    })
  })

  it('returns 405 on PUT to /:page/history/<shortSha>/<doc>', async () => {
    const { default: handler } = await import(
      '../../netlify/functions/router/router.mts'
    )
    const req = new Request('http://localhost/foo/history/abc1234/foo.txt', {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: 'hello'
    })
    const res = await handler(
      req,
      makeContext({ params: { page: 'foo', rest: 'abc1234/foo.txt' } })
    )

    expect(res.status).toBe(405)
    expect(mockCommitFileOnBranch).not.toHaveBeenCalled()
  })

  it('returns 405 on PUT to bucket-prefixed /:page/history/<YYYY>/<MM>/<shortSha>/<doc>', async () => {
    const { default: handler } = await import(
      '../../netlify/functions/router/router.mts'
    )
    const req = new Request('http://localhost/foo/history/2024/03/abc1234/foo.txt', {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: 'hello'
    })
    const res = await handler(
      req,
      makeContext({ params: { page: 'foo', rest: '2024/03/abc1234/foo.txt' } })
    )

    expect(res.status).toBe(405)
    expect(mockCommitFileOnBranch).not.toHaveBeenCalled()
  })

  it('returns 405 on PUT to /:page/history/<shortSha>/', async () => {
    const { default: handler } = await import(
      '../../netlify/functions/router/router.mts'
    )
    const req = new Request('http://localhost/foo/history/abc1234', {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: 'hello'
    })
    const res = await handler(
      req,
      makeContext({ params: { page: 'foo', rest: 'abc1234' } })
    )

    expect(res.status).toBe(405)
  })

  it('returns 405 on PUT to /:page/history/<YYYY>/', async () => {
    const { default: handler } = await import(
      '../../netlify/functions/router/router.mts'
    )
    const req = new Request('http://localhost/foo/history/2026', {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: 'hello'
    })
    const res = await handler(
      req,
      makeContext({ params: { page: 'foo', rest: '2026' } })
    )

    expect(res.status).toBe(405)
  })

  it('returns 405 on PUT to /:page/history/ root', async () => {
    const { default: handler } = await import(
      '../../netlify/functions/router/router.mts'
    )
    const req = new Request('http://localhost/foo/history', {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: 'hello'
    })
    const res = await handler(
      req,
      makeContext({ params: { page: 'foo', rest: '' } })
    )

    expect(res.status).toBe(405)
  })
})
