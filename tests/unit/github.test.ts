import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { fetchFileFromGitHub, GitHubFetchError } from '../../src/github.js'

describe('fetchFileFromGitHub', () => {
  const ORIGINAL_FETCH = globalThis.fetch

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH
  })

  function mockFetchOnce(response: Response): ReturnType<typeof vi.fn> {
    const fn = vi.fn().mockResolvedValueOnce(response)
    globalThis.fetch = fn as unknown as typeof fetch
    return fn
  }

  it('builds the contents URL with owner, repo, ref, and encoded path', async () => {
    const fetchMock = mockFetchOnce(
      new Response('hello', { status: 200, headers: { 'content-type': 'text/plain' } })
    )

    await fetchFileFromGitHub({
      repo: 'octocat/hello-world',
      token: 'ghp_test',
      ref: 'main',
      path: 'docs/read me.md'
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.github.com/repos/octocat/hello-world/contents/docs/read%20me.md?ref=main')
    expect(init.method).toBe('GET')
  })

  it('uses HEAD as default ref when not provided', async () => {
    const fetchMock = mockFetchOnce(new Response('ok', { status: 200 }))

    await fetchFileFromGitHub({
      repo: 'octocat/hello-world',
      token: 'ghp_test',
      path: 'foo/bar'
    })

    const [url] = fetchMock.mock.calls[0]
    expect(url).toContain('?ref=HEAD')
  })

  it('sends Authorization, raw Accept, API version, and User-Agent headers', async () => {
    const fetchMock = mockFetchOnce(new Response('ok', { status: 200 }))

    await fetchFileFromGitHub({
      repo: 'octocat/hello-world',
      token: 'ghp_test',
      ref: 'main',
      path: 'foo/bar'
    })

    const [, init] = fetchMock.mock.calls[0]
    const headers = init.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer ghp_test')
    expect(headers['Accept']).toBe('application/vnd.github.raw')
    expect(headers['X-GitHub-Api-Version']).toBe('2022-11-28')
    expect(headers['User-Agent']).toBe('solid-github-netlify')
  })

  it('forwards an If-None-Match header when provided', async () => {
    const fetchMock = mockFetchOnce(new Response('ok', { status: 200 }))

    await fetchFileFromGitHub({
      repo: 'octocat/hello-world',
      token: 'ghp_test',
      ref: 'main',
      path: 'foo/bar',
      ifNoneMatch: 'W/"abc123"'
    })

    const [, init] = fetchMock.mock.calls[0]
    const headers = init.headers as Record<string, string>
    expect(headers['If-None-Match']).toBe('W/"abc123"')
  })

  it('returns status, body, and forwarded headers on a 200', async () => {
    mockFetchOnce(
      new Response('# Hello', {
        status: 200,
        headers: {
          'content-type': 'text/markdown; charset=utf-8',
          etag: 'W/"deadbeef"'
        }
      })
    )

    const result = await fetchFileFromGitHub({
      repo: 'octocat/hello-world',
      token: 'ghp_test',
      ref: 'main',
      path: 'docs/readme.md'
    })

    expect(result.status).toBe(200)
    expect(result.body).toBe('# Hello')
    expect(result.contentType).toBe('text/markdown; charset=utf-8')
    expect(result.etag).toBe('W/"deadbeef"')
  })

  it('passes through a 404 status without throwing', async () => {
    mockFetchOnce(
      new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain' } })
    )

    const result = await fetchFileFromGitHub({
      repo: 'octocat/hello-world',
      token: 'ghp_test',
      ref: 'main',
      path: 'missing/file'
    })

    expect(result.status).toBe(404)
    expect(result.body).toBe('Not Found')
  })

  it('throws GitHubFetchError on network failure', async () => {
    globalThis.fetch = vi.fn().mockRejectedValueOnce(new Error('network down')) as unknown as typeof fetch

    await expect(
      fetchFileFromGitHub({
        repo: 'octocat/hello-world',
        token: 'ghp_test',
        ref: 'main',
        path: 'foo/bar'
      })
    ).rejects.toBeInstanceOf(GitHubFetchError)
  })

  it('throws GitHubFetchError on 5xx upstream', async () => {
    mockFetchOnce(new Response('boom', { status: 502 }))

    await expect(
      fetchFileFromGitHub({
        repo: 'octocat/hello-world',
        token: 'ghp_test',
        ref: 'main',
        path: 'foo/bar'
      })
    ).rejects.toBeInstanceOf(GitHubFetchError)
  })
})
