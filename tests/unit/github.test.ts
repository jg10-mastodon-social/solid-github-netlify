import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import {
  fetchFileFromGitHub,
  GitHubFetchError,
  GitHubApiError,
  getBranchRef,
  getDefaultBranch,
  createBranchFromSha,
  getFileBlobSha,
  commitFile,
  commitFileOnBranch,
} from '../../src/github.js'

function textResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, init)
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  })
}

function mockFetchSequence(responses: Response[]): ReturnType<typeof vi.fn> {
  const fn = vi.fn()
  for (const r of responses) fn.mockResolvedValueOnce(r)
  globalThis.fetch = fn as unknown as typeof fetch
  return fn
}

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
    expect(new TextDecoder().decode(result.body)).toBe('# Hello')
    expect(result.contentType).toBe('text/markdown; charset=utf-8')
    expect(result.etag).toBe('W/"deadbeef"')
  })

  it('returns binary content as Uint8Array without UTF-8 corruption', async () => {
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0x80])
    mockFetchOnce(
      new Response(pngBytes, {
        status: 200,
        headers: { 'content-type': 'image/png' }
      })
    )

    const result = await fetchFileFromGitHub({
      repo: 'octocat/hello-world',
      token: 'ghp_test',
      ref: 'main',
      path: 'images/logo.png'
    })

    expect(result.body).toBeInstanceOf(Uint8Array)
    expect(Array.from(result.body)).toEqual(Array.from(pngBytes))
  })

  it('captures the upstream Cache-Control header', async () => {
    mockFetchOnce(
      new Response('ok', {
        status: 200,
        headers: { 'cache-control': 'private, max-age=60' }
      })
    )

    const result = await fetchFileFromGitHub({
      repo: 'octocat/hello-world',
      token: 'ghp_test',
      ref: 'main',
      path: 'foo/bar'
    })

    expect(result.cacheControl).toBe('private, max-age=60')
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
    expect(new TextDecoder().decode(result.body)).toBe('Not Found')
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

describe('getBranchRef', () => {
  const ORIGINAL_FETCH = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH
  })

  it('GETs git/ref/heads/{branch} and returns the object SHA on 200', async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse({ object: { sha: 'abc123' } }, { status: 200 })
    ])

    const sha = await getBranchRef({ repo: 'octocat/hello-world', token: 'ghp_test', branch: 'foo-draft' })

    expect(sha).toBe('abc123')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.github.com/repos/octocat/hello-world/git/ref/heads/foo-draft')
    expect(init.method).toBe('GET')
    const headers = init.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer ghp_test')
    expect(headers['Accept']).toBe('application/vnd.github+json')
    expect(headers['X-GitHub-Api-Version']).toBe('2022-11-28')
    expect(headers['User-Agent']).toBe('solid-github-netlify')
  })

  it('encodes slashes in branch names', async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse({ object: { sha: 'abc' } }, { status: 200 })
    ])

    await getBranchRef({ repo: 'octocat/hello-world', token: 'ghp_test', branch: 'feature/foo' })

    const [url] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.github.com/repos/octocat/hello-world/git/ref/heads/feature/foo')
  })

  it('returns null on 404', async () => {
    mockFetchSequence([new Response('Not Found', { status: 404 })])

    const sha = await getBranchRef({ repo: 'octocat/hello-world', token: 'ghp_test', branch: 'missing' })

    expect(sha).toBeNull()
  })

  it('throws GitHubApiError on 422', async () => {
    mockFetchSequence([new Response('Unprocessable', { status: 422 })])

    await expect(
      getBranchRef({ repo: 'octocat/hello-world', token: 'ghp_test', branch: 'bad..name' })
    ).rejects.toBeInstanceOf(GitHubApiError)
  })

  it('throws GitHubApiError on 5xx', async () => {
    mockFetchSequence([new Response('boom', { status: 502 })])

    await expect(
      getBranchRef({ repo: 'octocat/hello-world', token: 'ghp_test', branch: 'foo-draft' })
    ).rejects.toBeInstanceOf(GitHubApiError)
  })

  it('throws GitHubApiError on network failure', async () => {
    globalThis.fetch = vi.fn().mockRejectedValueOnce(new Error('network down')) as unknown as typeof fetch

    await expect(
      getBranchRef({ repo: 'octocat/hello-world', token: 'ghp_test', branch: 'foo-draft' })
    ).rejects.toBeInstanceOf(GitHubApiError)
  })
})

describe('getDefaultBranch', () => {
  const ORIGINAL_FETCH = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH
  })

  it('GETs /repos/{owner}/{repo} and returns default_branch', async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse({ default_branch: 'main' }, { status: 200 })
    ])

    const branch = await getDefaultBranch({ repo: 'octocat/hello-world', token: 'ghp_test' })

    expect(branch).toBe('main')
    const [url] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.github.com/repos/octocat/hello-world')
  })

  it('throws GitHubApiError on 5xx', async () => {
    mockFetchSequence([new Response('boom', { status: 502 })])

    await expect(
      getDefaultBranch({ repo: 'octocat/hello-world', token: 'ghp_test' })
    ).rejects.toBeInstanceOf(GitHubApiError)
  })
})

describe('createBranchFromSha', () => {
  const ORIGINAL_FETCH = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH
  })

  it('POSTs git/refs with refs/heads/{branch} and sha', async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse({ ref: 'refs/heads/foo-draft' }, { status: 201 })
    ])

    await createBranchFromSha({
      repo: 'octocat/hello-world',
      token: 'ghp_test',
      branch: 'foo-draft',
      sha: 'base-sha'
    })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.github.com/repos/octocat/hello-world/git/refs')
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer ghp_test')
    expect(headers['Content-Type']).toBe('application/json')
    const body = JSON.parse(init.body as string)
    expect(body).toEqual({ ref: 'refs/heads/foo-draft', sha: 'base-sha' })
  })

  it('encodes slashes in branch names', async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse({}, { status: 201 })
    ])

    await createBranchFromSha({
      repo: 'octocat/hello-world',
      token: 'ghp_test',
      branch: 'feature/foo',
      sha: 'sha'
    })

    const [, init] = fetchMock.mock.calls[0]
    const body = JSON.parse(init.body as string)
    expect(body.ref).toBe('refs/heads/feature/foo')
  })

  it('throws GitHubApiError on 422 (e.g. branch already exists)', async () => {
    mockFetchSequence([new Response('Reference already exists', { status: 422 })])

    await expect(
      createBranchFromSha({
        repo: 'octocat/hello-world',
        token: 'ghp_test',
        branch: 'foo-draft',
        sha: 'sha'
      })
    ).rejects.toBeInstanceOf(GitHubApiError)
  })

  it('throws GitHubApiError on 5xx', async () => {
    mockFetchSequence([new Response('boom', { status: 502 })])

    await expect(
      createBranchFromSha({
        repo: 'octocat/hello-world',
        token: 'ghp_test',
        branch: 'foo-draft',
        sha: 'sha'
      })
    ).rejects.toBeInstanceOf(GitHubApiError)
  })

  it('throws GitHubApiError on network failure', async () => {
    globalThis.fetch = vi.fn().mockRejectedValueOnce(new Error('network down')) as unknown as typeof fetch

    await expect(
      createBranchFromSha({
        repo: 'octocat/hello-world',
        token: 'ghp_test',
        branch: 'foo-draft',
        sha: 'sha'
      })
    ).rejects.toBeInstanceOf(GitHubApiError)
  })
})

describe('getFileBlobSha', () => {
  const ORIGINAL_FETCH = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH
  })

  it('GETs the contents API with JSON accept and ref query, returns SHA on 200', async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse({ sha: 'file-sha' }, { status: 200 })
    ])

    const sha = await getFileBlobSha({
      repo: 'octocat/hello-world',
      token: 'ghp_test',
      ref: 'foo-draft',
      path: 'foo/bar'
    })

    expect(sha).toBe('file-sha')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.github.com/repos/octocat/hello-world/contents/foo/bar?ref=foo-draft')
    const headers = init.headers as Record<string, string>
    expect(headers['Accept']).toBe('application/vnd.github+json')
  })

  it('returns null on 404 (new file)', async () => {
    mockFetchSequence([new Response('Not Found', { status: 404 })])

    const sha = await getFileBlobSha({
      repo: 'octocat/hello-world',
      token: 'ghp_test',
      ref: 'foo-draft',
      path: 'foo/new'
    })

    expect(sha).toBeNull()
  })

  it('encodes path segments', async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse({ sha: 'sha' }, { status: 200 })
    ])

    await getFileBlobSha({
      repo: 'octocat/hello-world',
      token: 'ghp_test',
      ref: 'main',
      path: 'docs/read me.md'
    })

    const [url] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.github.com/repos/octocat/hello-world/contents/docs/read%20me.md?ref=main')
  })

  it('throws GitHubApiError on 5xx', async () => {
    mockFetchSequence([new Response('boom', { status: 502 })])

    await expect(
      getFileBlobSha({
        repo: 'octocat/hello-world',
        token: 'ghp_test',
        ref: 'foo-draft',
        path: 'foo/bar'
      })
    ).rejects.toBeInstanceOf(GitHubApiError)
  })
})

describe('commitFile', () => {
  const ORIGINAL_FETCH = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH
  })

  it('PUTs to contents API with message, base64 content, and branch; omits sha when not provided', async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse(
        {
          commit: { sha: 'commit-sha', html_url: 'https://github.com/octocat/hello-world/commit/abc' }
        },
        { status: 201 }
      )
    ])

    const result = await commitFile({
      repo: 'octocat/hello-world',
      token: 'ghp_test',
      branch: 'foo-draft',
      path: 'foo/bar',
      message: 'Update foo/bar',
      content: Buffer.from('hello').toString('base64')
    })

    expect(result).toEqual({
      commitSha: 'commit-sha',
      htmlUrl: 'https://github.com/octocat/hello-world/commit/abc'
    })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.github.com/repos/octocat/hello-world/contents/foo/bar')
    expect(init.method).toBe('PUT')
    const body = JSON.parse(init.body as string)
    expect(body).toEqual({
      message: 'Update foo/bar',
      content: Buffer.from('hello').toString('base64'),
      branch: 'foo-draft'
    })
    expect(body.sha).toBeUndefined()
  })

  it('includes sha in the body when provided (file update)', async () => {
    mockFetchSequence([
      jsonResponse({ commit: { sha: 'c', html_url: 'u' } }, { status: 200 })
    ])

    await commitFile({
      repo: 'octocat/hello-world',
      token: 'ghp_test',
      branch: 'foo-draft',
      path: 'foo/bar',
      message: 'Update',
      content: Buffer.from('hello').toString('base64'),
      sha: 'file-sha'
    })

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    const [, init] = fetchMock.mock.calls[0]
    const body = JSON.parse(init.body as string)
    expect(body.sha).toBe('file-sha')
  })

  it('accepts a 200 response on update (in addition to 201 on create)', async () => {
    mockFetchSequence([
      jsonResponse({ commit: { sha: 'c', html_url: 'u' } }, { status: 200 })
    ])

    const result = await commitFile({
      repo: 'octocat/hello-world',
      token: 'ghp_test',
      branch: 'foo-draft',
      path: 'foo/bar',
      message: 'Update',
      content: Buffer.from('hello').toString('base64')
    })

    expect(result.commitSha).toBe('c')
  })

  it('throws GitHubApiError on 422 (e.g. branch protection)', async () => {
    mockFetchSequence([new Response('protected', { status: 422 })])

    await expect(
      commitFile({
        repo: 'octocat/hello-world',
        token: 'ghp_test',
        branch: 'main',
        path: 'foo/bar',
        message: 'Update',
        content: Buffer.from('hello').toString('base64')
      })
    ).rejects.toBeInstanceOf(GitHubApiError)
  })

  it('throws GitHubApiError on 5xx', async () => {
    mockFetchSequence([new Response('boom', { status: 502 })])

    await expect(
      commitFile({
        repo: 'octocat/hello-world',
        token: 'ghp_test',
        branch: 'foo-draft',
        path: 'foo/bar',
        message: 'Update',
        content: Buffer.from('hello').toString('base64')
      })
    ).rejects.toBeInstanceOf(GitHubApiError)
  })
})

describe('commitFileOnBranch', () => {
  const ORIGINAL_FETCH = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH
  })

  it('skips branch creation when the branch exists and creates a new file without sha', async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse({ object: { sha: 'branch-sha' } }, { status: 200 }), // getBranchRef
      new Response('Not Found', { status: 404 }),                       // getFileBlobSha
      jsonResponse(
        { commit: { sha: 'commit-sha', html_url: 'https://example/commit' } },
        { status: 201 }
      ) // commitFile
    ])

    const result = await commitFileOnBranch({
      repo: 'octocat/hello-world',
      token: 'ghp_test',
      baseRef: 'main',
      branch: 'foo-draft',
      path: 'foo/bar',
      content: Buffer.from('hello').toString('base64'),
      message: 'Update foo/bar'
    })

    expect(result).toEqual({
      commitSha: 'commit-sha',
      htmlUrl: 'https://example/commit',
      branch: 'foo-draft'
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const [, fileLookupInit] = fetchMock.mock.calls[1]
    expect(fileLookupInit.method).toBe('GET')
    const [, commitInit] = fetchMock.mock.calls[2]
    expect(commitInit.method).toBe('PUT')
    const commitBody = JSON.parse(commitInit.body as string)
    expect(commitBody.sha).toBeUndefined()
    expect(commitBody.branch).toBe('foo-draft')
  })

  it('creates the branch from baseRef SHA when missing', async () => {
    const fetchMock = mockFetchSequence([
      new Response('Not Found', { status: 404 }),                       // getBranchRef (foo-draft missing)
      jsonResponse({ object: { sha: 'main-sha' } }, { status: 200 }),   // getBranchRef (main)
      jsonResponse({}, { status: 201 }),                                  // createBranchFromSha
      new Response('Not Found', { status: 404 }),                       // getFileBlobSha (new file)
      jsonResponse({ commit: { sha: 'c', html_url: 'u' } }, { status: 201 }) // commitFile
    ])

    await commitFileOnBranch({
      repo: 'octocat/hello-world',
      token: 'ghp_test',
      baseRef: 'main',
      branch: 'foo-draft',
      path: 'foo/bar',
      content: Buffer.from('hi').toString('base64'),
      message: 'Update'
    })

    expect(fetchMock).toHaveBeenCalledTimes(5)
    const [, createInit] = fetchMock.mock.calls[2]
    expect(createInit.method).toBe('POST')
    const createBody = JSON.parse(createInit.body as string)
    expect(createBody).toEqual({ ref: 'refs/heads/foo-draft', sha: 'main-sha' })
  })

  it('discovers default branch when baseRef is "HEAD"', async () => {
    const fetchMock = mockFetchSequence([
      new Response('Not Found', { status: 404 }),                       // getBranchRef (foo-draft missing)
      jsonResponse({ default_branch: 'trunk' }, { status: 200 }),       // getDefaultBranch
      jsonResponse({ object: { sha: 'trunk-sha' } }, { status: 200 }),  // getBranchRef (trunk)
      jsonResponse({}, { status: 201 }),                                  // createBranchFromSha
      new Response('Not Found', { status: 404 }),                       // getFileBlobSha
      jsonResponse({ commit: { sha: 'c', html_url: 'u' } }, { status: 201 })
    ])

    await commitFileOnBranch({
      repo: 'octocat/hello-world',
      token: 'ghp_test',
      baseRef: 'HEAD',
      branch: 'foo-draft',
      path: 'foo/bar',
      content: Buffer.from('hi').toString('base64'),
      message: 'Update'
    })

    const urls = fetchMock.mock.calls.map(([u]) => u)
    expect(urls[1]).toBe('https://api.github.com/repos/octocat/hello-world')
    expect(urls[2]).toBe('https://api.github.com/repos/octocat/hello-world/git/ref/heads/trunk')
    const [, createInit] = fetchMock.mock.calls[3]
    const createBody = JSON.parse(createInit.body as string)
    expect(createBody.sha).toBe('trunk-sha')
  })

  it('passes file SHA to commitFile when file already exists on the branch', async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse({ object: { sha: 'branch-sha' } }, { status: 200 }), // getBranchRef
      jsonResponse({ sha: 'existing-file-sha' }, { status: 200 }),     // getFileBlobSha
      jsonResponse({ commit: { sha: 'c', html_url: 'u' } }, { status: 200 })
    ])

    await commitFileOnBranch({
      repo: 'octocat/hello-world',
      token: 'ghp_test',
      baseRef: 'main',
      branch: 'foo-draft',
      path: 'foo/bar',
      content: Buffer.from('updated').toString('base64'),
      message: 'Update'
    })

    const [, commitInit] = fetchMock.mock.calls[2]
    const body = JSON.parse(commitInit.body as string)
    expect(body.sha).toBe('existing-file-sha')
  })

  it('propagates GitHubApiError from getBranchRef on the base ref', async () => {
    mockFetchSequence([
      new Response('Not Found', { status: 404 }),                       // foo-draft missing
      new Response('boom', { status: 502 })                              // base ref lookup fails
    ])

    await expect(
      commitFileOnBranch({
        repo: 'octocat/hello-world',
        token: 'ghp_test',
        baseRef: 'main',
        branch: 'foo-draft',
        path: 'foo/bar',
        content: Buffer.from('hi').toString('base64'),
        message: 'Update'
      })
    ).rejects.toBeInstanceOf(GitHubApiError)
  })
})
