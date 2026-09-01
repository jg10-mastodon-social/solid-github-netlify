import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Context } from '@netlify/functions'

vi.mock('../../src/auth.js', () => ({
  verifyDpopToken: vi.fn()
}))

const mockLoadWriteConfig = vi.fn(() => ({ writeWebIds: [] }))
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

vi.mock('../../src/github.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/github.js')>()
  return {
    ...actual,
    fetchFileFromGitHub: mockFetchFileFromGitHub,
    isPathSafe: mockIsPathSafe
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
  it('declares path /:page*/:doc', async () => {
    const { config } = await import('../../netlify/functions/router/router.mts')
    expect(config.path).toEqual(['/:page*/:doc'])
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

  it('returns 200 with the upstream body and content-type', async () => {
    mockFetchFileFromGitHub.mockResolvedValueOnce({
      status: 200,
      body: '# Hello',
      contentType: 'text/markdown; charset=utf-8',
      etag: 'W/"abc"'
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/bar', { method: 'GET' })
    const res = await handler(req, makeContext({ params: { page: 'foo', doc: 'bar' } }))

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('# Hello')
    expect(res.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8')
    expect(res.headers.get('ETag')).toBe('W/"abc"')
  })

  it('assembles path from page and doc', async () => {
    mockFetchFileFromGitHub.mockResolvedValueOnce({
      status: 200,
      body: 'ok',
      contentType: 'text/plain',
      etag: null
    })

    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/a/b/c', { method: 'GET' })
    await handler(req, makeContext({ params: { page: 'a/b', doc: 'c' } }))

    expect(mockFetchFileFromGitHub).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'a/b/c' })
    )
  })

  it('passes If-None-Match to GitHub and returns 304 on a 304 upstream', async () => {
    mockFetchFileFromGitHub.mockResolvedValueOnce({
      status: 304,
      body: '',
      contentType: null,
      etag: 'W/"abc"'
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
      body: 'Not Found',
      contentType: 'text/plain',
      etag: null
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
      body: 'ok',
      contentType: 'text/plain',
      etag: 'W/"abc"'
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
