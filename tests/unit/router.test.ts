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
const mockSquashMergeBranch = vi.fn()
const mockDeleteBranch = vi.fn()
const mockGetCommit = vi.fn()

vi.mock('../../src/github.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/github.js')>()
  return {
    ...actual,
    fetchFileFromGitHub: mockFetchFileFromGitHub,
    isPathSafe: mockIsPathSafe,
    commitFileOnBranch: mockCommitFileOnBranch,
    getFileBlobSha: mockGetFileBlobSha,
    listDirectoryFromGitHub: mockListDirectoryFromGitHub,
    listCommitsForPath: mockListCommitsForPath,
    squashMergeBranch: mockSquashMergeBranch,
    deleteBranch: mockDeleteBranch,
    getCommit: mockGetCommit
  }
})

const mockExtractCreateActivity = vi.fn()
const mockAppendCurrentClientTriples = vi.fn()

vi.mock('../../src/changelog.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/changelog.js')>()
  return {
    ...actual,
    ChangelogValidationError: class extends Error {
      readonly status = 422
      constructor(message: string) {
        super(message)
        this.name = 'ChangelogValidationError'
      }
    },
    extractCreateActivity: mockExtractCreateActivity,
    appendCurrentClientTriples: mockAppendCurrentClientTriples
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

  it('accepts PUT, GET, OPTIONS, PATCH and POST methods', async () => {
    const { config } = await import('../../netlify/functions/router/router.mts')
    expect(config.method).toEqual(expect.arrayContaining(['PUT', 'GET', 'OPTIONS', 'PATCH', 'POST']))
    expect(config.method).toHaveLength(5)
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

  it('serves a repo-root file when the URL has no page prefix (regression: /index.ttl)', async () => {
    mockFetchFileFromGitHub.mockResolvedValueOnce({
      status: 200,
      body: textBody('@prefix ex: <http://example/> .'),
      contentType: 'text/turtle; charset=utf-8',
      etag: 'W/"root"',
      cacheControl: null
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/index.ttl', { method: 'GET' })
    const res = await handler(req, makeContext({ params: { doc: 'index.ttl' } }))

    expect(mockFetchFileFromGitHub).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'index.ttl', ref: 'HEAD' })
    )
    expect(mockFetchFileFromGitHub).not.toHaveBeenCalledWith(
      expect.objectContaining({ path: expect.stringContaining('undefined') })
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/turtle; charset=utf-8')
    expect(await res.text()).toBe('@prefix ex: <http://example/> .')
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

  it('forwards the upstream Content-Type on a 404 instead of guessing from the file extension', async () => {
    mockFetchFileFromGitHub.mockResolvedValueOnce({
      status: 404,
      body: textBody('{"message":"Not Found"}'),
      contentType: 'application/json; charset=utf-8',
      etag: null,
      cacheControl: null
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/missing.ttl', { method: 'GET' })
    const res = await handler(req, makeContext({ params: { page: 'foo', doc: 'missing.ttl' } }))

    expect(res.status).toBe(404)
    expect(res.headers.get('Content-Type')).toBe('application/json; charset=utf-8')
    expect(await res.text()).toBe('{"message":"Not Found"}')
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

  it('reads a root-level file from the literal "draft" branch when no page prefix is given', async () => {
    mockFetchFileFromGitHub.mockResolvedValueOnce({
      status: 200,
      body: textBody('draft root'),
      contentType: 'text/turtle; charset=utf-8',
      etag: 'W/"d"',
      cacheControl: null
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/history/draft/index.ttl', { method: 'GET' })
    const res = await handler(req, makeContext({ params: { doc: 'index.ttl' } }))

    expect(mockFetchFileFromGitHub).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'index.ttl', ref: 'draft' })
    )
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('draft root')
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

  it('commits a root-level file to the literal "draft" branch when no page prefix is given', async () => {
    mockCommitFileOnBranch.mockResolvedValueOnce({
      commitSha: 'root-sha',
      htmlUrl: 'https://github.com/octocat/hello-world/commit/root',
      branch: 'draft',
      contentSha: 'root-blob'
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/history/draft/index.ttl', {
      method: 'PUT',
      headers: { 'Content-Type': 'text/turtle' },
      body: '<> a <http://example/> .'
    })
    const res = await handler(req, makeContext({ params: { doc: 'index.ttl' } }))

    expect(res.status).toBe(200)
    expect(mockCommitFileOnBranch).toHaveBeenCalledTimes(1)
    expect(mockCommitFileOnBranch).toHaveBeenCalledWith(
      expect.objectContaining({
        branch: 'draft',
        path: 'index.ttl',
        baseRef: 'HEAD'
      })
    )
    const body = await res.json()
    expect(body).toEqual(
      expect.objectContaining({ branch: 'draft', path: 'index.ttl' })
    )
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
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    expect(res.headers.get('Netlify-CDN-Cache-Control')).toBe('no-store')
  })

  it('returns WAC-Allow with user="read" when no Authorization header is present', async () => {
    mockFetchFileFromGitHub.mockResolvedValueOnce(okResult())

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/draft/bar', { method: 'GET' })
    const res = await handler(req, makeContext({ params: { page: 'foo', doc: 'bar' } }))

    expect(res.headers.get('WAC-Allow')).toBe('user="read", public="read"')
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    expect(res.headers.get('Netlify-CDN-Cache-Control')).toBe('no-store')
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
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    expect(res.headers.get('Netlify-CDN-Cache-Control')).toBe('no-store')
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
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    expect(res.headers.get('Netlify-CDN-Cache-Control')).toBe('no-store')
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
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    expect(res.headers.get('Netlify-CDN-Cache-Control')).toBe('no-store')
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
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    expect(res.headers.get('Netlify-CDN-Cache-Control')).toBe('no-store')
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
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    expect(res.headers.get('Netlify-CDN-Cache-Control')).toBe('no-store')
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
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    expect(res.headers.get('Netlify-CDN-Cache-Control')).toBe('no-store')
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
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    expect(res.headers.get('Netlify-CDN-Cache-Control')).toBe('no-store')
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

  it('does not set Netlify-CDN-Cache-Control on the published route', async () => {
    mockFetchFileFromGitHub.mockResolvedValueOnce({
      status: 200,
      body: new TextEncoder().encode('ok'),
      contentType: 'text/plain',
      etag: null,
      cacheControl: 'private, max-age=60'
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/bar', { method: 'GET' })
    const res = await handler(req, makeContext({ params: { page: 'foo', doc: 'bar' } }))

    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=60')
    expect(res.headers.get('Netlify-CDN-Cache-Control')).toBeNull()
  })

  it('exposes WAC-Allow via Access-Control-Expose-Headers on the published route CORS preflight', async () => {
    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/bar', { method: 'OPTIONS' })
    const res = await handler(req, makeContext({ params: { page: 'foo', doc: 'bar' } }))

    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Expose-Headers')).toContain('WAC-Allow')
    expect(res.headers.get('Access-Control-Expose-Headers')).toContain(
      'Netlify-CDN-Cache-Control'
    )
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

  it('returns 422 when solid:deletes contains a variable', async () => {
    mockFetchFileFromGitHub.mockResolvedValueOnce({
      status: 200,
      body: textBody(`${PREFIXES}ex:alice ex:p ex:carol .\n`),
      contentType: 'text/turtle; charset=utf-8',
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
      body: patchBody('ex:a ex:p ex:b .', { deletes: '?s ex:p ex:carol' })
    })
    const res = await handler(req, makeContext({ params: { page: 'foo', doc: 'data.ttl' } }))

    expect(res.status).toBe(422)
    expect(mockCommitFileOnBranch).not.toHaveBeenCalled()
  })

  it('returns 200 with commit info when applying a deletes+inserts patch to an existing .ttl file', async () => {
    mockFetchFileFromGitHub.mockResolvedValueOnce({
      status: 200,
      body: textBody(`${PREFIXES}ex:alice ex:knows ex:carol .\nex:alice ex:knows ex:bob .\n`),
      contentType: 'text/turtle; charset=utf-8',
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
      body: patchBody('ex:eve ex:knows ex:alice .', {
        deletes: 'ex:alice ex:knows ex:carol'
      })
    })
    const res = await handler(req, makeContext({ params: { page: 'foo', doc: 'data.ttl' } }))

    expect(res.status).toBe(200)
    expect(res.headers.get('ETag')).toBe('"new-blob"')
    expect(mockCommitFileOnBranch).toHaveBeenCalledTimes(1)
    const committed = mockCommitFileOnBranch.mock.calls[0]![0]
    const decoded = Buffer.from(committed.content, 'base64').toString('utf-8')
    expect(decoded).not.toMatch(/ex:carol/)
    expect(decoded).toContain('ex:bob')
    expect(decoded).toContain('ex:eve')
  })

  it('returns 200 with commit info when applying a deletes-only patch to an existing .ttl file', async () => {
    mockFetchFileFromGitHub.mockResolvedValueOnce({
      status: 200,
      body: textBody(`${PREFIXES}
ex:alice ex:knows ex:carol .
ex:alice ex:knows ex:bob .
`),
      contentType: 'text/turtle; charset=utf-8',
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
      body: patchBody('', { deletes: 'ex:alice ex:knows ex:carol .\nex:alice ex:knows ex:bob' })
    })
    const res = await handler(req, makeContext({ params: { page: 'foo', doc: 'data.ttl' } }))

    expect(res.status).toBe(200)
    expect(mockCommitFileOnBranch).toHaveBeenCalledTimes(1)
    const committed = mockCommitFileOnBranch.mock.calls[0]![0]
    const decoded = Buffer.from(committed.content, 'base64').toString('utf-8')
    expect(decoded).not.toMatch(/ex:carol/)
    expect(decoded).not.toMatch(/ex:bob/)
  })

  it('returns 409 when a delete triple is not present in the existing file', async () => {
    mockFetchFileFromGitHub.mockResolvedValueOnce({
      status: 200,
      body: textBody(`${PREFIXES}ex:alice ex:knows ex:carol .\n`),
      contentType: 'text/turtle; charset=utf-8',
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
      body: patchBody('ex:eve ex:knows ex:alice .', {
        deletes: 'ex:bob ex:knows ex:carol'
      })
    })
    const res = await handler(req, makeContext({ params: { page: 'foo', doc: 'data.ttl' } }))

    expect(res.status).toBe(409)
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

  it('patches a root-level file at the repo root when no page prefix is given', async () => {
    mockFetchFileFromGitHub.mockResolvedValueOnce({
      status: 404,
      body: textBody(''),
      contentType: null,
      etag: null,
      cacheControl: null
    })
    mockCommitFileOnBranch.mockResolvedValueOnce({
      commitSha: 'root-sha',
      htmlUrl: 'https://example/commit/root',
      branch: 'draft',
      contentSha: 'root-blob-sha'
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/history/draft/data.ttl', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'text/n3',
        authorization: 'DPoP token',
        dpop: 'dpop'
      },
      body: patchBody('ex:a ex:p ex:b .')
    })
    const res = await handler(req, makeContext({ params: { doc: 'data.ttl' } }))

    expect(res.status).toBe(200)
    expect(mockFetchFileFromGitHub).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'data.ttl', ref: 'draft' })
    )
    expect(mockCommitFileOnBranch).toHaveBeenCalledWith(
      expect.objectContaining({ branch: 'draft', path: 'data.ttl' })
    )
  })
})

describe('router changelog month PATCH handler', () => {
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

  it('returns 405 when PATCH is sent to /:page/history/changelog/ (no year/month)', async () => {
    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/changelog/', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'text/n3',
        authorization: 'DPoP token',
        dpop: 'dpop'
      },
      body: patchBody('ex:alice ex:p ex:bob .')
    })
    const res = await handler(
      req,
      makeContext({ params: { page: 'foo', rest: 'changelog/' } })
    )

    expect(res.status).toBe(405)
    expect(mockCommitFileOnBranch).not.toHaveBeenCalled()
  })

  it('returns 405 when PATCH is sent to /:page/history/changelog/<year>/ (no month)', async () => {
    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/changelog/2024/', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'text/n3',
        authorization: 'DPoP token',
        dpop: 'dpop'
      },
      body: patchBody('ex:alice ex:p ex:bob .')
    })
    const res = await handler(
      req,
      makeContext({ params: { page: 'foo', rest: 'changelog/2024/' } })
    )

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
    const req = new Request('http://localhost/foo/history/changelog/2024/03', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'text/n3',
        authorization: 'DPoP token',
        dpop: 'dpop'
      },
      body: patchBody('ex:alice ex:p ex:bob .')
    })
    const res = await handler(
      req,
      makeContext({ params: { page: 'foo', rest: 'changelog/2024/03' } })
    )

    expect(res.status).toBe(401)
    expect(mockCommitFileOnBranch).not.toHaveBeenCalled()
  })

  it('returns 404 when the month URL ends in .ttl', async () => {
    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/changelog/2024/03.ttl', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'text/n3',
        authorization: 'DPoP token',
        dpop: 'dpop'
      },
      body: patchBody('ex:alice ex:p ex:bob .')
    })
    const res = await handler(
      req,
      makeContext({ params: { page: 'foo', rest: 'changelog/2024/03.ttl' } })
    )

    expect(res.status).toBe(404)
    expect(mockCommitFileOnBranch).not.toHaveBeenCalled()
    expect(mockFetchFileFromGitHub).not.toHaveBeenCalled()
  })

  it('returns 404 when the month URL has a trailing slash', async () => {
    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/changelog/2024/03/', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'text/n3',
        authorization: 'DPoP token',
        dpop: 'dpop'
      },
      body: patchBody('ex:alice ex:p ex:bob .')
    })
    const res = await handler(
      req,
      makeContext({ params: { page: 'foo', rest: 'changelog/2024/03/' } })
    )

    expect(res.status).toBe(404)
    expect(mockCommitFileOnBranch).not.toHaveBeenCalled()
    expect(mockFetchFileFromGitHub).not.toHaveBeenCalled()
  })

  it('returns 415 when Content-Type is not text/n3', async () => {
    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/changelog/2024/03', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/sparql-update',
        authorization: 'DPoP token',
        dpop: 'dpop'
      },
      body: patchBody('ex:alice ex:p ex:bob .')
    })
    const res = await handler(
      req,
      makeContext({ params: { page: 'foo', rest: 'changelog/2024/03' } })
    )

    expect(res.status).toBe(415)
    expect(mockCommitFileOnBranch).not.toHaveBeenCalled()
  })

  it('returns 200 with commit info when applying an insert patch to an existing shard', async () => {
    mockFetchFileFromGitHub.mockResolvedValueOnce({
      status: 200,
      body: textBody(`${PREFIXES}ex:alice ex:knows ex:carol .\n`),
      contentType: 'text/turtle; charset=utf-8',
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
    const req = new Request('http://localhost/foo/history/changelog/2024/03', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'text/n3',
        authorization: 'DPoP token',
        dpop: 'dpop'
      },
      body: patchBody('ex:eve ex:knows ex:alice .')
    })
    const res = await handler(
      req,
      makeContext({ params: { page: 'foo', rest: 'changelog/2024/03' } })
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('ETag')).toBe('"new-blob"')
    expect(res.headers.get('Content-Type')).toContain('application/json')
    const body = await res.json()
    expect(body.commit).toBe('commit-sha')
    expect(body.branch).toBe('foo-draft')
    expect(body.path).toBe('foo/.changelog/2024/03.ttl')
    expect(mockCommitFileOnBranch).toHaveBeenCalledTimes(1)
    const committed = mockCommitFileOnBranch.mock.calls[0]![0]
    expect(committed.branch).toBe('foo-draft')
    expect(committed.path).toBe('foo/.changelog/2024/03.ttl')
    expect(committed.message).toBe('PATCH foo/.changelog/2024/03.ttl via solid-github-netlify')
    const decoded = Buffer.from(committed.content, 'base64').toString('utf-8')
    expect(decoded).toContain('ex:eve')
    expect(decoded).toContain('ex:alice')
    expect(decoded).toContain('ex:carol')
  })

  it('returns 200 with commit info when creating a new shard from a missing file', async () => {
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
    const req = new Request('http://localhost/foo/history/changelog/2024/03', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'text/n3',
        authorization: 'DPoP token',
        dpop: 'dpop'
      },
      body: patchBody('ex:alice ex:knows ex:bob .')
    })
    const res = await handler(
      req,
      makeContext({ params: { page: 'foo', rest: 'changelog/2024/03' } })
    )

    expect(res.status).toBe(200)
    expect(mockCommitFileOnBranch).toHaveBeenCalledTimes(1)
    const committed = mockCommitFileOnBranch.mock.calls[0]![0]
    expect(committed.sha).toBeUndefined()
    expect(committed.branch).toBe('foo-draft')
    expect(committed.path).toBe('foo/.changelog/2024/03.ttl')
    expect(mockFetchFileFromGitHub).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'foo/.changelog/2024/03.ttl', ref: 'foo-draft' })
    )
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
    const req = new Request('http://localhost/foo/history/changelog/2024/03', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'text/n3',
        authorization: 'DPoP token',
        dpop: 'dpop'
      },
      body: 'this is not valid n3'
    })
    const res = await handler(
      req,
      makeContext({ params: { page: 'foo', rest: 'changelog/2024/03' } })
    )

    expect(res.status).toBe(422)
    expect(mockCommitFileOnBranch).not.toHaveBeenCalled()
  })

  it('returns 409 when a delete triple is not present in the existing shard', async () => {
    mockFetchFileFromGitHub.mockResolvedValueOnce({
      status: 200,
      body: textBody(`${PREFIXES}ex:alice ex:knows ex:carol .\n`),
      contentType: 'text/turtle; charset=utf-8',
      etag: null,
      cacheControl: null
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/changelog/2024/03', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'text/n3',
        authorization: 'DPoP token',
        dpop: 'dpop'
      },
      body: patchBody('ex:eve ex:knows ex:alice .', {
        deletes: 'ex:bob ex:knows ex:carol'
      })
    })
    const res = await handler(
      req,
      makeContext({ params: { page: 'foo', rest: 'changelog/2024/03' } })
    )

    expect(res.status).toBe(409)
    expect(mockCommitFileOnBranch).not.toHaveBeenCalled()
  })

  it('returns 400 when the constructed path is unsafe', async () => {
    mockIsPathSafe.mockReturnValueOnce(false)

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo%2F..%2Fbar/history/changelog/2024/03', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'text/n3',
        authorization: 'DPoP token',
        dpop: 'dpop'
      },
      body: patchBody('ex:a ex:p ex:b .')
    })
    const res = await handler(
      req,
      makeContext({ params: { page: 'foo/../bar', rest: 'changelog/2024/03' } })
    )

    expect(res.status).toBe(400)
    expect(mockCommitFileOnBranch).not.toHaveBeenCalled()
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
    mockListCommitsForPath.mockReset()
    mockListCommitsForPath.mockResolvedValue([])
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
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    expect(res.headers.get('Netlify-CDN-Cache-Control')).toBe('no-store')
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
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    expect(res.headers.get('Netlify-CDN-Cache-Control')).toBe('no-store')
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
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    expect(res.headers.get('Netlify-CDN-Cache-Control')).toBe('no-store')
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
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    expect(res.headers.get('Netlify-CDN-Cache-Control')).toBe('no-store')
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

  it('GET /foo/ calls listCommitsForPath with perPage=1 against HEAD to fetch the latest commit', async () => {
    mockListDirectoryFromGitHub.mockResolvedValueOnce({
      status: 200,
      entries: [{ name: 'bar.txt', path: 'foo/bar.txt', type: 'file', sha: 'sha-b' }]
    })
    mockListCommitsForPath.mockResolvedValueOnce([])

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/', { method: 'GET' })
    await handler(req, makeContext({ params: { page: 'foo' } }))

    expect(mockListCommitsForPath).toHaveBeenCalledTimes(1)
    const args = mockListCommitsForPath.mock.calls[0][0]
    expect(args.repo).toBe('octocat/hello-world')
    expect(args.branch).toBe('HEAD')
    expect(args.path).toBe('foo')
    expect(args.perPage).toBe(1)
  })

  it('GET /foo/ emits memento/sameAs/wasGeneratedBy triples when the page has at least one commit', async () => {
    mockListDirectoryFromGitHub.mockResolvedValueOnce({
      status: 200,
      entries: [{ name: 'bar.txt', path: 'foo/bar.txt', type: 'file', sha: 'sha-b' }]
    })
    mockListCommitsForPath.mockResolvedValueOnce([
      {
        sha: 'abcdef1234567890abcdef1234567890abcdef12',
        message: 'msg',
        authorName: 'a',
        authorEmail: 'a@b',
        date: '2024-03-15T10:00:00Z',
        htmlUrl: 'https://github.com/...'
      }
    ])

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/', { method: 'GET' })
    const res = await handler(req, makeContext({ params: { page: 'foo' } }))

    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toMatch(
      /<>\s+a\s+ldp:Container,\s+ldp:BasicContainer[^.]*[\s\S]*<http:\/\/mementoweb\.org\/ns#memento>\s+<http:\/\/localhost\/foo\/history\/abcdef1\/>/,
    )
    expect(body).toMatch(
      /<http:\/\/www\.w3\.org\/2002\/07\/owl#sameAs>\s+<http:\/\/localhost\/foo\/history\/abcdef1\/>/
    )
    expect(body).toMatch(
      /<http:\/\/www\.w3\.org\/ns\/prov#wasGeneratedBy>\s+<http:\/\/localhost\/foo\/history\/changelog\/2024\/03#abcdef1>/
    )
  })

  it('GET /foo/ derives year/month from the latest commit date (UTC, zero-padded)', async () => {
    mockListDirectoryFromGitHub.mockResolvedValueOnce({ status: 200, entries: [] })
    mockListCommitsForPath.mockResolvedValueOnce([
      {
        sha: '0123456789abcdef0123456789abcdef01234567',
        message: 'msg',
        authorName: 'a',
        authorEmail: 'a@b',
        date: '2026-01-05T00:00:00Z',
        htmlUrl: 'https://github.com/...'
      }
    ])

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/', { method: 'GET' })
    const res = await handler(req, makeContext({ params: { page: 'foo' } }))

    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('changelog/2026/01#0123456')
  })

  it('GET /foo/ omits the provenance/memento triples when the page has no commits', async () => {
    mockListDirectoryFromGitHub.mockResolvedValueOnce({ status: 200, entries: [] })
    mockListCommitsForPath.mockResolvedValueOnce([])

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/', { method: 'GET' })
    const res = await handler(req, makeContext({ params: { page: 'foo' } }))

    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).not.toContain('mementoweb.org/ns#memento')
    expect(body).not.toContain('owl#sameAs')
    expect(body).not.toContain('prov#wasGeneratedBy')
    expect(body).toMatch(/<>\s+a\s+ldp:Container,\s+ldp:BasicContainer\s*\./)
  })

  it('GET /foo/history/draft/ does not emit the provenance/memento triples', async () => {
    mockListDirectoryFromGitHub.mockResolvedValueOnce({
      status: 200,
      entries: [{ name: 'bar.txt', path: 'foo/bar.txt', type: 'file', sha: 'sha-d' }]
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/draft/', { method: 'GET' })
    const res = await handler(req, makeContext({ params: { page: 'foo' } }))

    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).not.toContain('mementoweb.org/ns#memento')
    expect(body).not.toContain('owl#sameAs')
    expect(body).not.toContain('prov#wasGeneratedBy')
    expect(mockListCommitsForPath).not.toHaveBeenCalled()
  })

  it('GET / (repo root) does not emit the provenance/memento triples', async () => {
    mockListDirectoryFromGitHub.mockResolvedValueOnce({
      status: 200,
      entries: [{ name: 'foo', path: 'foo', type: 'dir', sha: 'sha-f' }]
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/', { method: 'GET' })
    const res = await handler(req, makeContext({ params: {} }))

    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).not.toContain('mementoweb.org/ns#memento')
    expect(body).not.toContain('owl#sameAs')
    expect(body).not.toContain('prov#wasGeneratedBy')
    expect(mockListCommitsForPath).not.toHaveBeenCalled()
  })

  it('serves GET /history/draft/ as the root container on the literal "draft" branch (regression: empty page splat)', async () => {
    mockListDirectoryFromGitHub.mockResolvedValueOnce({
      status: 200,
      entries: [
        { name: 'index.ttl', path: 'index.ttl', type: 'file', sha: 'sha-i' },
        { name: 'README.md', path: 'README.md', type: 'file', sha: 'sha-r' }
      ]
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/history/draft/', { method: 'GET' })
    const res = await handler(req, makeContext({ params: {} }))

    expect(mockListDirectoryFromGitHub).toHaveBeenCalledWith(
      expect.objectContaining({ path: '', ref: 'draft' })
    )
    expect(mockListDirectoryFromGitHub).not.toHaveBeenCalledWith(
      expect.objectContaining({ ref: expect.stringContaining('-draft') })
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/turtle; charset=utf-8')
  })
})

describe('router GET directory-index for /:page*/ with Accept preferring HTML', () => {
  beforeEach(() => {
    mockFetchFileFromGitHub.mockReset()
    mockListDirectoryFromGitHub.mockReset()
    mockListCommitsForPath.mockReset()
    mockListCommitsForPath.mockResolvedValue([])
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

  function textBody(text: string): Uint8Array {
    return new TextEncoder().encode(text)
  }

  it('GET /foo/ with Accept: text/html serves foo/index.html from GitHub', async () => {
    mockFetchFileFromGitHub.mockResolvedValueOnce({
      status: 200,
      body: textBody('<html>foo index</html>'),
      contentType: 'text/html; charset=utf-8',
      etag: 'W/"idx"',
      cacheControl: 'public, max-age=60'
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/', {
      method: 'GET',
      headers: { Accept: 'text/html' }
    })
    const res = await handler(req, makeContext({ params: { page: 'foo' } }))

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('<html>foo index</html>')
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
    expect(res.headers.get('ETag')).toBe('W/"idx"')
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60')
    expect(mockFetchFileFromGitHub).toHaveBeenCalledTimes(1)
    expect(mockFetchFileFromGitHub).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'foo/index.html', ref: 'HEAD' })
    )
    expect(mockListDirectoryFromGitHub).not.toHaveBeenCalled()
  })

  it('GET / (root) with Accept: text/html serves index.html at the repo root', async () => {
    mockFetchFileFromGitHub.mockResolvedValueOnce({
      status: 200,
      body: textBody('<html>root</html>'),
      contentType: 'text/html; charset=utf-8',
      etag: null,
      cacheControl: null
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/', {
      method: 'GET',
      headers: { Accept: 'text/html' }
    })
    const res = await handler(req, makeContext({ params: {} }))

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
    expect(mockFetchFileFromGitHub).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'index.html', ref: 'HEAD' })
    )
    expect(mockListDirectoryFromGitHub).not.toHaveBeenCalled()
  })

  it('GET /foo/ with Accept: text/html and no index.html falls back to Turtle listing', async () => {
    mockFetchFileFromGitHub.mockResolvedValueOnce({
      status: 404,
      body: textBody(''),
      contentType: null,
      etag: null,
      cacheControl: null
    })
    mockListDirectoryFromGitHub.mockResolvedValueOnce({
      status: 200,
      entries: [{ name: 'bar.txt', path: 'foo/bar.txt', type: 'file', sha: 'sha-b' }]
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/', {
      method: 'GET',
      headers: { Accept: 'text/html' }
    })
    const res = await handler(req, makeContext({ params: { page: 'foo' } }))

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/turtle; charset=utf-8')
    expect(mockFetchFileFromGitHub).toHaveBeenCalledTimes(1)
    expect(mockListDirectoryFromGitHub).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'foo', ref: 'HEAD' })
    )
  })

  it('GET /foo/ with Accept: text/turtle skips the index lookup and serves Turtle directly', async () => {
    mockListDirectoryFromGitHub.mockResolvedValueOnce({
      status: 200,
      entries: [{ name: 'bar.txt', path: 'foo/bar.txt', type: 'file', sha: 'sha-b' }]
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/', {
      method: 'GET',
      headers: { Accept: 'text/turtle' }
    })
    const res = await handler(req, makeContext({ params: { page: 'foo' } }))

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/turtle; charset=utf-8')
    expect(mockFetchFileFromGitHub).not.toHaveBeenCalled()
  })

  it('GET /foo/ with no Accept header keeps the legacy Turtle default', async () => {
    mockListDirectoryFromGitHub.mockResolvedValueOnce({
      status: 200,
      entries: []
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/', { method: 'GET' })
    const res = await handler(req, makeContext({ params: { page: 'foo' } }))

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/turtle; charset=utf-8')
    expect(mockFetchFileFromGitHub).not.toHaveBeenCalled()
  })

  it('GET /foo/ with Accept: text/html and If-None-Match forwards the header to GitHub and emits Vary', async () => {
    mockFetchFileFromGitHub.mockResolvedValueOnce({
      status: 304,
      body: textBody(''),
      contentType: null,
      etag: 'W/"idx"',
      cacheControl: null
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/', {
      method: 'GET',
      headers: { Accept: 'text/html', 'If-None-Match': 'W/"idx"' }
    })
    const res = await handler(req, makeContext({ params: { page: 'foo' } }))

    expect(res.status).toBe(304)
    expect(res.headers.get('Vary')).toContain('If-None-Match')
    expect(mockFetchFileFromGitHub).toHaveBeenCalledWith(
      expect.objectContaining({ ifNoneMatch: 'W/"idx"' })
    )
  })

  it('GET /foo/history/draft/ with Accept: text/html serves draft index.html read-only', async () => {
    mockFetchFileFromGitHub.mockResolvedValueOnce({
      status: 200,
      body: textBody('<html>draft index</html>'),
      contentType: 'text/html; charset=utf-8',
      etag: 'W/"d"',
      cacheControl: null
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/draft/', {
      method: 'GET',
      headers: { Accept: 'text/html' }
    })
    const res = await handler(req, makeContext({ params: { page: 'foo' } }))

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
    expect(res.headers.get('WAC-Allow')).toBe('user="read", public="read"')
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    expect(res.headers.get('Netlify-CDN-Cache-Control')).toBe('no-store')
    expect(res.headers.get('Allow')).toBeNull()
    expect(res.headers.get('Accept-Put')).toBeNull()
    expect(res.headers.get('Accept-Patch')).toBeNull()
    expect(mockFetchFileFromGitHub).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'foo/index.html', ref: 'foo-draft' })
    )
    expect(mockListDirectoryFromGitHub).not.toHaveBeenCalled()
  })

  it('GET /foo/history/draft/ with Accept: text/html and no index.html falls back to the existing Turtle listing', async () => {
    mockFetchFileFromGitHub.mockResolvedValueOnce({
      status: 404,
      body: textBody(''),
      contentType: null,
      etag: null,
      cacheControl: null
    })
    mockListDirectoryFromGitHub.mockResolvedValueOnce({
      status: 200,
      entries: []
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/draft/', {
      method: 'GET',
      headers: { Accept: 'text/html' }
    })
    const res = await handler(req, makeContext({ params: { page: 'foo' } }))

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/turtle; charset=utf-8')
    expect(res.headers.get('WAC-Allow')).toBe('user="read", public="read"')
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    expect(mockFetchFileFromGitHub).toHaveBeenCalledTimes(1)
    expect(mockListDirectoryFromGitHub).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'foo', ref: 'foo-draft' })
    )
  })

  it('GET /foo/ with Accept: text/html,application/xhtml+xml serves index.html', async () => {
    mockFetchFileFromGitHub.mockResolvedValueOnce({
      status: 200,
      body: textBody('<html>x</html>'),
      contentType: 'text/html; charset=utf-8',
      etag: null,
      cacheControl: null
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/', {
      method: 'GET',
      headers: { Accept: 'text/html,application/xhtml+xml' }
    })
    const res = await handler(req, makeContext({ params: { page: 'foo' } }))

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
    expect(mockFetchFileFromGitHub).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'foo/index.html' })
    )
  })

  it('GET /foo/ with Accept: text/html;q=0.5, text/turtle;q=0.9 prefers Turtle (no index lookup)', async () => {
    mockListDirectoryFromGitHub.mockResolvedValueOnce({
      status: 200,
      entries: []
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/', {
      method: 'GET',
      headers: { Accept: 'text/html;q=0.5, text/turtle;q=0.9' }
    })
    const res = await handler(req, makeContext({ params: { page: 'foo' } }))

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/turtle; charset=utf-8')
    expect(mockFetchFileFromGitHub).not.toHaveBeenCalled()
  })

  it('GET /foo/history/ (history root) is never routed to the index lookup', async () => {
    mockListCommitsForPath.mockResolvedValueOnce([])

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
    expect(mockFetchFileFromGitHub).not.toHaveBeenCalled()
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
    expect(body).toContain('<changelog/>')
    expect(body).toContain('<draft/>')
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

  it('history_root listing includes <changelog/> as an ldp:contains child', async () => {
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
    expect(body).toMatch(/ldp:contains [^;]*<changelog\/>/)
    expect(body).toMatch(/<changelog\/>\s+a\s+ldp:Container,\s+ldp:BasicContainer/)
  })

  it('history_root listing includes <draft/> as an ldp:contains child', async () => {
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
    expect(body).toMatch(/ldp:contains [^;]*<draft\/>/)
    expect(body).toMatch(/<draft\/>\s+a\s+ldp:Container,\s+ldp:BasicContainer/)
  })

  it('history_root listing lists <changelog/> and <draft/> unconditionally without any GitHub API calls', async () => {
    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history', { method: 'GET' })
    await handler(req, makeContext({ params: { page: 'foo', rest: '' } }))

    expect(mockListCommitsForPath).not.toHaveBeenCalled()
    expect(mockListDirectoryFromGitHub).not.toHaveBeenCalled()
    expect(mockFetchFileFromGitHub).not.toHaveBeenCalled()
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
    expect(body).toMatch(/<a href="changelog\/?">changelog\/<\/a>/)
    expect(body).toMatch(/<a href="draft\/?">draft\/<\/a>/)
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
    const draftIdx = (config.path ?? []).indexOf('/:page*/history/draft/:doc*')
    const catchAllIdx = (config.path ?? []).indexOf('/:page*/history/:rest*')
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
    expect(body).not.toMatch(/ldp:contains/)
    expect(body).toMatch(/<>\s+a\s+ldp:Container,\s+ldp:BasicContainer\s*\./)
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
    expect(body).not.toMatch(/ldp:contains/)
    expect(body).toMatch(/<>\s+a\s+ldp:Container,\s+ldp:BasicContainer\s*\./)
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
    mockGetCommit.mockReset()
    mockGetCommit.mockResolvedValue(null)
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

  it('emits an empty container (200 with no ldp:contains) when the commit has no files for the page', async () => {
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
    expect(body).not.toMatch(/ldp:contains/)
    expect(body).toMatch(/<>\s+a\s+ldp:Container,\s+ldp:BasicContainer/)
    expect(body).toContain('mementoweb.org/ns#original')
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

  it('emits prov:wasGeneratedBy pointing at the changelog activity for the commit (using commit date year/month)', async () => {
    mockListDirectoryFromGitHub.mockResolvedValueOnce({
      status: 200,
      entries: [
        { name: 'index.html', path: 'foo/index.html', type: 'file', sha: 'sha-1' }
      ]
    })
    mockGetCommit.mockResolvedValueOnce({
      sha: 'abcdef1234567890abcdef1234567890abcdef12',
      message: 'msg',
      authorName: 'a',
      authorEmail: 'a@b',
      date: '2024-03-15T10:00:00Z',
      htmlUrl: 'https://github.com/...'
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
    expect(mockGetCommit).toHaveBeenCalledWith(
      expect.objectContaining({ sha: 'abc1234' })
    )
    expect(body).toMatch(
      /<http:\/\/www\.w3\.org\/ns\/prov#wasGeneratedBy>\s+<http:\/\/localhost\/foo\/history\/changelog\/2024\/03#abc1234>\s*[.;]/
    )
  })

  it('emits memento:original pointing at the page root', async () => {
    mockListDirectoryFromGitHub.mockResolvedValueOnce({
      status: 200,
      entries: [
        { name: 'index.html', path: 'foo/index.html', type: 'file', sha: 'sha-1' }
      ]
    })
    mockGetCommit.mockResolvedValueOnce({
      sha: 'abcdef1234567890abcdef1234567890abcdef12',
      message: 'msg',
      authorName: 'a',
      authorEmail: 'a@b',
      date: '2024-03-15T10:00:00Z',
      htmlUrl: 'https://github.com/...'
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
    expect(body).toMatch(
      /<http:\/\/mementoweb\.org\/ns#original>\s+<http:\/\/localhost\/foo\/>\s*[.;]/
    )
  })

  it('omits prov:wasGeneratedBy but keeps memento:original when getCommit returns null', async () => {
    mockListDirectoryFromGitHub.mockResolvedValueOnce({
      status: 200,
      entries: [
        { name: 'index.html', path: 'foo/index.html', type: 'file', sha: 'sha-1' }
      ]
    })
    mockGetCommit.mockResolvedValueOnce(null)

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
    expect(body).not.toContain('prov#wasGeneratedBy')
    expect(body).toMatch(
      /<http:\/\/mementoweb\.org\/ns#original>\s+<http:\/\/localhost\/foo\/>/
    )
  })

  it('emits prov:wasGeneratedBy and memento:original even when the folder is empty', async () => {
    mockListDirectoryFromGitHub.mockResolvedValueOnce({
      status: 200,
      entries: []
    })
    mockGetCommit.mockResolvedValueOnce({
      sha: 'abcdef1234567890abcdef1234567890abcdef12',
      message: 'msg',
      authorName: 'a',
      authorEmail: 'a@b',
      date: '2026-08-01T00:00:00Z',
      htmlUrl: 'https://github.com/...'
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
    expect(body).toContain('prov#wasGeneratedBy')
    expect(body).toContain(
      'changelog/2026/08#abc1234'
    )
    expect(body).toContain('mementoweb.org/ns#original')
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

describe('router changelog POST handler', () => {
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
    mockSquashMergeBranch.mockReset()
    mockDeleteBranch.mockReset()
    mockExtractCreateActivity.mockReset()
    mockAppendCurrentClientTriples.mockReset()
    mockListCommitsForPath.mockReset()
    mockListCommitsForPath.mockResolvedValue([])

    mockExtractCreateActivity.mockReturnValue({
      blankNode: '_:b1',
      activityQuads: [{ subject: { value: '_:b1' }, predicate: { value: 'p' }, object: { value: 'o' } }] as any,
      message: 'Initial save'
    })
    mockAppendCurrentClientTriples.mockResolvedValue({
      content: 'sparql-prefix-stuff',
      appended: true
    })
    mockSquashMergeBranch.mockResolvedValue({
      sha: 'merged-sha',
      htmlUrl: 'https://github.com/octocat/hello-world/commit/merged-sha',
      commitSha: 'merged-sha'
    })
    mockCommitFileOnBranch.mockResolvedValue({
      commitSha: 'committed-blob',
      htmlUrl: 'https://github.com/octocat/hello-world/commit/blob',
      branch: 'foo-draft',
      contentSha: 'new-blob'
    })
    mockDeleteBranch.mockResolvedValue(undefined)
  })

  function textBody(text: string): Uint8Array {
    return new TextEncoder().encode(text)
  }

  function postContext() {
    return makeContext({ params: { page: 'foo', rest: 'changelog/' } })
  }

  it('returns 405 when POST is sent to a non-changelog URI', async () => {
    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/draft/data.ttl', {
      method: 'POST',
      headers: {
        'Content-Type': 'text/turtle',
        authorization: 'DPoP token',
        dpop: 'dpop'
      },
      body: '<#create> a <http://example/C> .'
    })
    const res = await handler(req, makeContext({ params: { page: 'foo', doc: 'data.ttl' } }))

    expect(res.status).toBe(405)
    expect(mockCommitFileOnBranch).not.toHaveBeenCalled()
    expect(mockSquashMergeBranch).not.toHaveBeenCalled()
    expect(mockDeleteBranch).not.toHaveBeenCalled()
  })

  it('returns 405 when POST is sent to a changelog month URI', async () => {
    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/changelog/2024/03.ttl', {
      method: 'POST',
      headers: {
        'Content-Type': 'text/turtle',
        authorization: 'DPoP token',
        dpop: 'dpop'
      },
      body: '<#create> a <http://example/C> .'
    })
    const res = await handler(
      req,
      makeContext({ params: { page: 'foo', rest: 'changelog/2024/03.ttl' } })
    )

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
    const req = new Request('http://localhost/foo/history/changelog/', {
      method: 'POST',
      headers: {
        'Content-Type': 'text/turtle',
        authorization: 'DPoP token',
        dpop: 'dpop'
      },
      body: '<#create> a <http://example/C> .'
    })
    const res = await handler(req, postContext())

    expect(res.status).toBe(401)
    expect(mockCommitFileOnBranch).not.toHaveBeenCalled()
    expect(mockSquashMergeBranch).not.toHaveBeenCalled()
    expect(mockDeleteBranch).not.toHaveBeenCalled()
  })

  it('returns 415 when Content-Type is not text/turtle', async () => {
    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/changelog/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/sparql-update',
        authorization: 'DPoP token',
        dpop: 'dpop'
      },
      body: '<#create> a <http://example/C> .'
    })
    const res = await handler(req, postContext())

    expect(res.status).toBe(415)
    expect(mockExtractCreateActivity).not.toHaveBeenCalled()
    expect(mockCommitFileOnBranch).not.toHaveBeenCalled()
  })

  it('returns 422 with "rdfs:label" in the message when the activity has no label', async () => {
    const { ChangelogValidationError } = await import('../../src/changelog.js')
    mockExtractCreateActivity.mockImplementationOnce(() => {
      throw new ChangelogValidationError('Commit message (rdfs:label) is required on the activity.')
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/changelog/', {
      method: 'POST',
      headers: {
        'Content-Type': 'text/turtle',
        authorization: 'DPoP token',
        dpop: 'dpop'
      },
      body: '<#create> a <http://example/C> .'
    })
    const res = await handler(req, postContext())

    expect(res.status).toBe(422)
    expect(await res.text()).toContain('rdfs:label')
    expect(mockCommitFileOnBranch).not.toHaveBeenCalled()
  })

  it('returns 422 with "Invalid Turtle body" on malformed body', async () => {
    const { ChangelogValidationError } = await import('../../src/changelog.js')
    mockExtractCreateActivity.mockImplementationOnce(() => {
      throw new ChangelogValidationError('Invalid Turtle body: bad syntax')
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/changelog/', {
      method: 'POST',
      headers: {
        'Content-Type': 'text/turtle',
        authorization: 'DPoP token',
        dpop: 'dpop'
      },
      body: 'this is not valid turtle <<<'
    })
    const res = await handler(req, postContext())

    expect(res.status).toBe(422)
    expect(await res.text()).toContain('Invalid Turtle body')
    expect(mockCommitFileOnBranch).not.toHaveBeenCalled()
  })

  it('returns 422 when the body has no as:Create activity', async () => {
    const { ChangelogValidationError } = await import('../../src/changelog.js')
    mockExtractCreateActivity.mockImplementationOnce(() => {
      throw new ChangelogValidationError('No as:Create activity in body.')
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/changelog/', {
      method: 'POST',
      headers: {
        'Content-Type': 'text/turtle',
        authorization: 'DPoP token',
        dpop: 'dpop'
      },
      body: '<#something> <http://example/p> "o" .'
    })
    const res = await handler(req, postContext())

    expect(res.status).toBe(422)
    expect(mockCommitFileOnBranch).not.toHaveBeenCalled()
  })

  it('returns 200 with commit info on a successful publish (empty shard + payload)', async () => {
    mockFetchFileFromGitHub.mockResolvedValueOnce({
      status: 404,
      body: textBody(''),
      contentType: null,
      etag: null,
      cacheControl: null
    })
    mockListCommitsForPath.mockResolvedValueOnce([
      {
        sha: 'def5678901234abcd',
        message: 'predecessor',
        authorName: 'Alice',
        authorEmail: 'alice@example',
        date: '2026-01-01T00:00:00Z',
        htmlUrl: 'https://example/commit/def5678'
      }
    ])

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/changelog/', {
      method: 'POST',
      headers: {
        'Content-Type': 'text/turtle',
        authorization: 'DPoP token',
        dpop: 'dpop'
      },
      body: `<#create> a <https://www.w3.org/ns/activitystreams#Create> ;
               <https://www.w3.org/ns/activitystreams#object> _:b1 .
              _:b1 <http://www.w3.org/2000/01/rdf-schema#label> "Initial save" ;
                   <http://example.org/custom> "foo" .`
    })
    const res = await handler(req, postContext())

    expect(res.status).toBe(200)
    expect(res.headers.get('ETag')).toBe('"merged-sha"')
    expect(res.headers.get('Content-Type')).toContain('application/json')

    const now = new Date()
    const year = now.getUTCFullYear()
    const month = String(now.getUTCMonth() + 1).padStart(2, '0')
    const expectedPath = `foo/.changelog/${year}/${month}.ttl`

    expect(mockCommitFileOnBranch).toHaveBeenCalledTimes(1)
    const committed = mockCommitFileOnBranch.mock.calls[0]![0]
    expect(committed.branch).toBe('foo-draft')
    expect(committed.path).toBe(expectedPath)
    expect(committed.message).toBe('Initial save')
    expect(committed.baseRef).toBe('HEAD')
    expect(committed.content).toBe(Buffer.from('sparql-prefix-stuff', 'utf-8').toString('base64'))

    expect(mockSquashMergeBranch).toHaveBeenCalledTimes(1)
    expect(mockSquashMergeBranch).toHaveBeenCalledWith(
      expect.objectContaining({
        base: 'HEAD',
        head: 'foo-draft',
        commitMessage: 'Initial save'
      })
    )

    expect(mockDeleteBranch).toHaveBeenCalledTimes(1)
    expect(mockDeleteBranch).toHaveBeenCalledWith(
      expect.objectContaining({ branch: 'foo-draft' })
    )

    const body = await res.json()
    expect(body.commit).toBe('merged-sha')
    expect(body.url).toBe('https://github.com/octocat/hello-world/commit/merged-sha')
    expect(body.branch).toBe('HEAD')
    expect(body.path).toBe(expectedPath)
    expect(body.etag).toBe('merged-sha')
    expect(body.activity).toBe('merged-')
  })

  it('returns 200 on a successful publish with empty payload (no commit, but squash and delete happen)', async () => {
    mockExtractCreateActivity.mockReturnValueOnce({
      blankNode: '_:b1',
      activityQuads: [],
      message: 'no payload'
    })
    mockAppendCurrentClientTriples.mockResolvedValueOnce({
      content: 'sparql-prefix-stuff',
      appended: false
    })
    mockFetchFileFromGitHub.mockResolvedValueOnce({
      status: 404,
      body: textBody(''),
      contentType: null,
      etag: null,
      cacheControl: null
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/changelog/', {
      method: 'POST',
      headers: {
        'Content-Type': 'text/turtle',
        authorization: 'DPoP token',
        dpop: 'dpop'
      },
      body: '<#create> a <https://www.w3.org/ns/activitystreams#Create> ; <https://www.w3.org/ns/activitystreams#object> _:b1 .\n_:b1 <http://www.w3.org/2000/01/rdf-schema#label> "no payload" .'
    })
    const res = await handler(req, postContext())

    expect(res.status).toBe(200)
    expect(mockCommitFileOnBranch).not.toHaveBeenCalled()
    expect(mockSquashMergeBranch).toHaveBeenCalledTimes(1)
    expect(mockSquashMergeBranch).toHaveBeenCalledWith(
      expect.objectContaining({ commitMessage: 'no payload' })
    )
    expect(mockDeleteBranch).toHaveBeenCalledTimes(1)
  })

  it('returns 200 on a successful publish when the shard already exists', async () => {
    mockFetchFileFromGitHub.mockResolvedValueOnce({
      status: 200,
      body: textBody(`<#previous> <http://example.org/custom> "before" .\n`),
      contentType: 'text/turtle; charset=utf-8',
      etag: 'W/"existing"',
      cacheControl: null
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/changelog/', {
      method: 'POST',
      headers: {
        'Content-Type': 'text/turtle',
        authorization: 'DPoP token',
        dpop: 'dpop'
      },
      body: `<#create> a <https://www.w3.org/ns/activitystreams#Create> ;
               <https://www.w3.org/ns/activitystreams#object> _:b1 .
              _:b1 <http://www.w3.org/2000/01/rdf-schema#label> "Initial save" ;
                   <http://example.org/custom> "foo" .`
    })
    const res = await handler(req, postContext())

    expect(res.status).toBe(200)
    expect(mockCommitFileOnBranch).toHaveBeenCalledTimes(1)
    const committed = mockCommitFileOnBranch.mock.calls[0]![0]
    expect(committed.content).toBe(Buffer.from('sparql-prefix-stuff', 'utf-8').toString('base64'))
    expect(committed.message).toBe('Initial save')
  })
})

describe('router changelog root GET', () => {
  beforeEach(() => {
    mockFetchFileFromGitHub.mockReset()
    mockListDirectoryFromGitHub.mockReset()
    mockListCommitsForPath.mockReset()
    mockIsPathSafe.mockReset()
    mockIsPathSafe.mockReturnValue(true)
    mockLoadGithubConfig.mockReturnValue({
      githubRepo: 'octocat/hello-world',
      githubToken: 'ghp_test',
      githubRef: 'HEAD'
    })
  })

  it('returns 200 with Content-Type text/turtle; charset=utf-8 when there are commits', async () => {
    mockListCommitsForPath.mockResolvedValueOnce([
      {
        sha: 'abc1234567890',
        message: 'commit',
        authorName: 'A',
        authorEmail: 'a@x',
        date: '2024-03-15T10:00:00Z',
        htmlUrl: 'https://example/commit/abc1234567890'
      }
    ] as any)

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/changelog', { method: 'GET' })
    const res = await handler(
      req,
      makeContext({ params: { page: 'foo', rest: 'changelog' } })
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/turtle; charset=utf-8')
  })

  it('returns 200 with an empty container when there are no commits', async () => {
    mockListCommitsForPath.mockResolvedValueOnce([])

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/changelog', { method: 'GET' })
    const res = await handler(
      req,
      makeContext({ params: { page: 'foo', rest: 'changelog' } })
    )

    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toMatch(/as:OrderedCollection\b/)
    expect(body).not.toMatch(/ldp:contains/)
  })

  it('emits as:OrderedCollection type, year sub-containers as ldp:contains, as:first and as:last', async () => {
    mockListCommitsForPath.mockResolvedValueOnce([
      {
        sha: 'abc1234567890',
        message: '2024 commit',
        authorName: 'A',
        authorEmail: 'a@x',
        date: '2024-03-15T10:00:00Z',
        htmlUrl: 'https://example/commit/abc1234567890'
      },
      {
        sha: 'def5678901234',
        message: '2025 commit',
        authorName: 'A',
        authorEmail: 'a@x',
        date: '2025-06-22T10:00:00Z',
        htmlUrl: 'https://example/commit/def5678901234'
      }
    ] as any)

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/changelog', { method: 'GET' })
    const res = await handler(
      req,
      makeContext({ params: { page: 'foo', rest: 'changelog' } })
    )

    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toMatch(/as:OrderedCollection\b/)
    expect(body).toContain('<2024/>')
    expect(body).toContain('<2025/>')
    expect(body).toMatch(/as:first <[^>]*2024\/>/)
    expect(body).toMatch(/as:last <[^>]*2025\/>/)
  })

  it('passes the page path to listCommitsForPath', async () => {
    mockListCommitsForPath.mockResolvedValueOnce([])

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/changelog', { method: 'GET' })
    await handler(
      req,
      makeContext({ params: { page: 'foo', rest: 'changelog' } })
    )

    expect(mockListCommitsForPath).toHaveBeenCalledTimes(1)
    const args = mockListCommitsForPath.mock.calls[0][0]
    expect(args.path).toBe('foo')
    expect(args.repo).toBe('octocat/hello-world')
    expect(args.branch).toBe('HEAD')
    expect(args.perPage).toBe(100)
  })

  it('groups commits by their UTC year across multiple years', async () => {
    mockListCommitsForPath.mockResolvedValueOnce([
      {
        sha: 'a1',
        message: 'Jan 2024',
        authorName: 'A',
        authorEmail: 'a@x',
        date: '2024-01-15T10:00:00Z',
        htmlUrl: 'https://example/commit/a1'
      },
      {
        sha: 'b2',
        message: 'Dec 2023',
        authorName: 'A',
        authorEmail: 'a@x',
        date: '2023-12-22T10:00:00Z',
        htmlUrl: 'https://example/commit/b2'
      },
      {
        sha: 'c3',
        message: 'Jul 2024',
        authorName: 'A',
        authorEmail: 'a@x',
        date: '2024-07-04T10:00:00Z',
        htmlUrl: 'https://example/commit/c3'
      }
    ] as any)

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/changelog', { method: 'GET' })
    const res = await handler(
      req,
      makeContext({ params: { page: 'foo', rest: 'changelog' } })
    )

    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('<2023/>')
    expect(body).toContain('<2024/>')
    expect(body).not.toContain('<2022/>')
  })
})

describe('router changelog year GET', () => {
  beforeEach(() => {
    mockFetchFileFromGitHub.mockReset()
    mockListDirectoryFromGitHub.mockReset()
    mockListCommitsForPath.mockReset()
    mockIsPathSafe.mockReset()
    mockIsPathSafe.mockReturnValue(true)
    mockLoadGithubConfig.mockReturnValue({
      githubRepo: 'octocat/hello-world',
      githubToken: 'ghp_test',
      githubRef: 'HEAD'
    })
  })

  it('returns 200 with Content-Type text/turtle; charset=utf-8 on success', async () => {
    mockListCommitsForPath.mockResolvedValueOnce([
      {
        sha: 'abc1234567890',
        message: 'commit',
        authorName: 'A',
        authorEmail: 'a@x',
        date: '2024-03-15T10:00:00Z',
        htmlUrl: 'https://example/commit/abc1234567890'
      }
    ] as any)

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/changelog/2024', {
      method: 'GET'
    })
    const res = await handler(
      req,
      makeContext({ params: { page: 'foo', rest: 'changelog/2024' } })
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/turtle; charset=utf-8')
  })

  it('returns 404 when year is after currentYear', async () => {
    const currentYear = new Date().getUTCFullYear()
    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request(`http://localhost/foo/history/changelog/${currentYear + 100}`, {
      method: 'GET'
    })
    const res = await handler(
      req,
      makeContext({ params: { page: 'foo', rest: `changelog/${currentYear + 100}` } })
    )

    expect(res.status).toBe(404)
    expect(mockListCommitsForPath).not.toHaveBeenCalled()
  })

  it('emits as:OrderedCollectionPage type, as:partOf, and month-page ldp:contains entries', async () => {
    mockListCommitsForPath.mockResolvedValueOnce([
      {
        sha: 'abc1234567890',
        message: 'Jan',
        authorName: 'A',
        authorEmail: 'a@x',
        date: '2024-01-15T10:00:00Z',
        htmlUrl: 'https://example/commit/abc1234567890'
      },
      {
        sha: 'def5678901234',
        message: 'Aug',
        authorName: 'A',
        authorEmail: 'a@x',
        date: '2024-08-22T10:00:00Z',
        htmlUrl: 'https://example/commit/def5678901234'
      }
    ] as any)

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/changelog/2024', {
      method: 'GET'
    })
    const res = await handler(
      req,
      makeContext({ params: { page: 'foo', rest: 'changelog/2024' } })
    )

    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('as:OrderedCollectionPage')
    expect(body).toMatch(/as:partOf/)
    // Months are advertised as ldp:Resource at bare URIs (no .ttl, no trailing slash)
    expect(body).toMatch(/<01>\s+a\s+ldp:Resource\s*\./)
    expect(body).toMatch(/<08>\s+a\s+ldp:Resource\s*\./)
    expect(body).not.toContain('<02/>')
    expect(body).not.toContain('<02> a ldp:Resource')
    expect(body).not.toContain('<01.ttl>')
    expect(body).toMatch(/as:items\s+<01>,\s*<08>/)
  })

  it('passes the page path and year since/until to listCommitsForPath', async () => {
    mockListCommitsForPath.mockResolvedValueOnce([])

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/changelog/2024', {
      method: 'GET'
    })
    await handler(
      req,
      makeContext({ params: { page: 'foo', rest: 'changelog/2024' } })
    )

    expect(mockListCommitsForPath).toHaveBeenCalledTimes(1)
    const args = mockListCommitsForPath.mock.calls[0][0]
    expect(args.path).toBe('foo')
    expect(args.since).toBe('2024-01-01T00:00:00Z')
    expect(args.until).toBe('2024-12-31T23:59:59Z')
  })

  it('returns 200 with an empty container when there are no commits in the year', async () => {
    mockListCommitsForPath.mockResolvedValueOnce([])

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/changelog/2024', {
      method: 'GET'
    })
    const res = await handler(
      req,
      makeContext({ params: { page: 'foo', rest: 'changelog/2024' } })
    )

    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('as:OrderedCollectionPage')
    expect(body).not.toMatch(/ldp:contains/)
  })
})

describe('router changelog month GET', () => {
  beforeEach(() => {
    mockFetchFileFromGitHub.mockReset()
    mockListDirectoryFromGitHub.mockReset()
    mockListCommitsForPath.mockReset()
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

  it('returns 200 with Content-Type text/turtle; charset=utf-8 on success', async () => {
    mockListCommitsForPath.mockResolvedValueOnce([])
    mockFetchFileFromGitHub.mockResolvedValueOnce({
      status: 404,
      body: textBody(''),
      contentType: null,
      etag: null,
      cacheControl: null
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/changelog/2024/03', {
      method: 'GET'
    })
    const res = await handler(
      req,
      makeContext({ params: { page: 'foo', rest: 'changelog/2024/03' } })
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/turtle; charset=utf-8')
  })

  it('returns 404 when year is after currentYear', async () => {
    const currentYear = new Date().getUTCFullYear()
    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request(`http://localhost/foo/history/changelog/${currentYear + 100}/03`, {
      method: 'GET'
    })
    const res = await handler(
      req,
      makeContext({ params: { page: 'foo', rest: `changelog/${currentYear + 100}/03` } })
    )

    expect(res.status).toBe(404)
    expect(mockFetchFileFromGitHub).not.toHaveBeenCalled()
    expect(mockListCommitsForPath).not.toHaveBeenCalled()
  })

  it('returns 404 when month is out of range (e.g. 13)', async () => {
    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/changelog/2024/13', {
      method: 'GET'
    })
    const res = await handler(
      req,
      makeContext({ params: { page: 'foo', rest: 'changelog/2024/13' } })
    )

    expect(res.status).toBe(404)
  })

  it('emits synthesized prov:endedAtTime, rdfs:label, and the OrderedCollectionPage envelope', async () => {
    mockListCommitsForPath.mockResolvedValueOnce([
      {
        sha: 'abc1234567890',
        message: 'Initial save',
        authorName: 'A',
        authorEmail: 'a@x',
        date: '2024-03-15T10:00:00Z',
        htmlUrl: 'https://example/commit/abc1234567890'
      }
    ] as any)
    mockFetchFileFromGitHub.mockResolvedValueOnce({
      status: 404,
      body: textBody(''),
      contentType: null,
      etag: null,
      cacheControl: null
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/changelog/2024/03', {
      method: 'GET'
    })
    const res = await handler(
      req,
      makeContext({ params: { page: 'foo', rest: 'changelog/2024/03' } })
    )

    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toMatch(/as:OrderedCollectionPage\b/)
    expect(body).toMatch(/as:partOf/)
    expect(body).toContain('prov:endedAtTime')
    expect(body).toContain('2024-03-15T10:00:00Z')
    expect(body).toContain('rdfs:label')
    expect(body).toContain('Initial save')
    expect(body).toMatch(/prov:Activity\b/)
  })

  it('merges client triples from the shard (subject <#current>) into the latest activity', async () => {
    mockListCommitsForPath.mockResolvedValueOnce([
      {
        sha: 'abc1234567890',
        message: 'Initial save',
        authorName: 'A',
        authorEmail: 'a@x',
        date: '2024-03-15T10:00:00Z',
        htmlUrl: 'https://example/commit/abc1234567890'
      }
    ] as any)
    mockFetchFileFromGitHub.mockResolvedValueOnce({
      status: 200,
      body: textBody(`<#current> <http://example.org/custom> "client data" .\n`),
      contentType: 'text/turtle; charset=utf-8',
      etag: null,
      cacheControl: null
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/changelog/2024/03', {
      method: 'GET'
    })
    const res = await handler(
      req,
      makeContext({ params: { page: 'foo', rest: 'changelog/2024/03' } })
    )

    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('client data')
    expect(body).toContain('abc1234')
  })

  it('treats a missing shard (404) as no client triples and still emits the envelope', async () => {
    mockListCommitsForPath.mockResolvedValueOnce([])
    mockFetchFileFromGitHub.mockResolvedValueOnce({
      status: 404,
      body: textBody(''),
      contentType: null,
      etag: null,
      cacheControl: null
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/changelog/2024/03', {
      method: 'GET'
    })
    const res = await handler(
      req,
      makeContext({ params: { page: 'foo', rest: 'changelog/2024/03' } })
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/turtle; charset=utf-8')
    const body = await res.text()
    expect(body).toMatch(/as:OrderedCollectionPage\b/)
  })

  it('fetches the shard from the per-month path on the githubRef branch', async () => {
    mockListCommitsForPath.mockResolvedValueOnce([])
    mockFetchFileFromGitHub.mockResolvedValueOnce({
      status: 404,
      body: textBody(''),
      contentType: null,
      etag: null,
      cacheControl: null
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/changelog/2024/03', {
      method: 'GET'
    })
    await handler(
      req,
      makeContext({ params: { page: 'foo', rest: 'changelog/2024/03' } })
    )

    expect(mockFetchFileFromGitHub).toHaveBeenCalledTimes(1)
    const args = mockFetchFileFromGitHub.mock.calls[0][0]
    expect(args.path).toBe('foo/.changelog/2024/03.ttl')
    expect(args.ref).toBe('HEAD')
  })

  it('calls listCommitsForPath with since/until scoped to the month', async () => {
    mockListCommitsForPath.mockResolvedValueOnce([])
    mockFetchFileFromGitHub.mockResolvedValueOnce({
      status: 404,
      body: textBody(''),
      contentType: null,
      etag: null,
      cacheControl: null
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/changelog/2024/03', {
      method: 'GET'
    })
    await handler(
      req,
      makeContext({ params: { page: 'foo', rest: 'changelog/2024/03' } })
    )

    expect(mockListCommitsForPath).toHaveBeenCalledTimes(1)
    const args = mockListCommitsForPath.mock.calls[0][0]
    expect(args.path).toBe('foo')
    expect(args.since).toBe('2024-03-01T00:00:00Z')
    expect(args.until).toBe('2024-03-31T23:59:59Z')
    expect(args.perPage).toBe(100)
  })

  it('returns 404 when the month URL ends in .ttl', async () => {
    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/changelog/2024/03.ttl', {
      method: 'GET'
    })
    const res = await handler(
      req,
      makeContext({ params: { page: 'foo', rest: 'changelog/2024/03.ttl' } })
    )

    expect(res.status).toBe(404)
    expect(mockFetchFileFromGitHub).not.toHaveBeenCalled()
    expect(mockListCommitsForPath).not.toHaveBeenCalled()
  })

  it('returns 404 when the month URL has a trailing slash', async () => {
    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/changelog/2024/03/', {
      method: 'GET'
    })
    const res = await handler(
      req,
      makeContext({ params: { page: 'foo', rest: 'changelog/2024/03/' } })
    )

    expect(res.status).toBe(404)
    expect(mockFetchFileFromGitHub).not.toHaveBeenCalled()
    expect(mockListCommitsForPath).not.toHaveBeenCalled()
  })

  it('addresses each commit activity as a local fragment of the month IRI (not the page IRI)', async () => {
    mockListCommitsForPath.mockResolvedValueOnce([
      {
        sha: 'abc1234567890',
        message: 'Initial save',
        authorName: 'A',
        authorEmail: 'a@x',
        date: '2024-03-15T10:00:00Z',
        htmlUrl: 'https://example/commit/abc1234567890'
      }
    ] as any)
    mockFetchFileFromGitHub.mockResolvedValueOnce({
      status: 404,
      body: textBody(''),
      contentType: null,
      etag: null,
      cacheControl: null
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/history/changelog/2024/03', {
      method: 'GET'
    })
    const res = await handler(
      req,
      makeContext({ params: { page: 'foo', rest: 'changelog/2024/03' } })
    )

    expect(res.status).toBe(200)
    const body = await res.text()
    // Activity subject is a local fragment of the month resource (relative IRI in serialization)
    expect(body).toContain('<#abc1234>')
    // as:items references the month-local fragment
    expect(body).toMatch(/as:items\s+<#abc1234>/)
    // Activity must NOT be addressed as a fragment of the page (/foo)
    expect(body).not.toContain('<http://localhost/foo#abc1234>')
  })
})
