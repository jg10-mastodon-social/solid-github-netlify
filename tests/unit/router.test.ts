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

vi.mock('../../src/github.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/github.js')>()
  return {
    ...actual,
    fetchFileFromGitHub: mockFetchFileFromGitHub,
    isPathSafe: mockIsPathSafe,
    commitFileOnBranch: mockCommitFileOnBranch,
    getFileBlobSha: mockGetFileBlobSha,
    listDirectoryFromGitHub: mockListDirectoryFromGitHub
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
  it('declares the draft route first so greedy :page* does not swallow /history/draft/ (regression)', async () => {
    const { config } = await import('../../netlify/functions/router/router.mts')
    expect(config.path).toEqual([
      '/:page*/history/draft/',
      '/:page*/history/draft/:doc*',
      '/:page*/',
      '/:page*/:doc',
      '/'
    ])
  })

  it('accepts PUT, GET and OPTIONS methods', async () => {
    const { config } = await import('../../netlify/functions/router/router.mts')
    expect(config.method).toEqual(expect.arrayContaining(['PUT', 'GET', 'OPTIONS']))
    expect(config.method).toHaveLength(3)
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
