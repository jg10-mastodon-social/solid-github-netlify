import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import {
  fetchFileFromGitHub,
  listDirectoryFromGitHub,
  GitHubFetchError,
  GitHubApiError,
  getBranchRef,
  getDefaultBranch,
  createBranchFromSha,
  getFileBlobSha,
  commitFile,
  commitFileOnBranch,
  parseIfMatch,
  listCommitsForPath,
  listFolderContentsAtCommit,
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
    expect(result.etag).toBe('W/"deadbeef"')
  })

  it('derives text/html content-type from a .html path even when upstream sends application/vnd.github.raw', async () => {
    mockFetchOnce(
      new Response('<html></html>', {
        status: 200,
        headers: { 'content-type': 'application/vnd.github.raw; charset=utf-8' }
      })
    )

    const result = await fetchFileFromGitHub({
      repo: 'octocat/hello-world',
      token: 'ghp_test',
      ref: 'main',
      path: 'docs/index.html'
    })

    expect(result.contentType).toBe('text/html; charset=utf-8')
  })

  it('derives text/markdown content-type from a .md path', async () => {
    mockFetchOnce(
      new Response('# Hi', {
        status: 200,
        headers: { 'content-type': 'application/vnd.github.raw; charset=utf-8' }
      })
    )

    const result = await fetchFileFromGitHub({
      repo: 'octocat/hello-world',
      token: 'ghp_test',
      ref: 'main',
      path: 'README.md'
    })

    expect(result.contentType).toBe('text/markdown; charset=utf-8')
  })

  it('derives image/png content-type from a .png path without a charset', async () => {
    mockFetchOnce(
      new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
        status: 200,
        headers: { 'content-type': 'application/vnd.github.raw' }
      })
    )

    const result = await fetchFileFromGitHub({
      repo: 'octocat/hello-world',
      token: 'ghp_test',
      ref: 'main',
      path: 'images/logo.png'
    })

    expect(result.contentType).toBe('image/png')
  })

  it('falls back to the upstream content-type when the path has no extension', async () => {
    mockFetchOnce(
      new Response('hello', {
        status: 200,
        headers: { 'content-type': 'application/vnd.github.raw; charset=utf-8' }
      })
    )

    const result = await fetchFileFromGitHub({
      repo: 'octocat/hello-world',
      token: 'ghp_test',
      ref: 'main',
      path: 'README'
    })

    expect(result.contentType).toBe('application/vnd.github.raw; charset=utf-8')
  })

  it('falls back to the upstream content-type when the file extension is unknown', async () => {
    mockFetchOnce(
      new Response('???', {
        status: 200,
        headers: { 'content-type': 'application/vnd.github.raw; charset=utf-8' }
      })
    )

    const result = await fetchFileFromGitHub({
      repo: 'octocat/hello-world',
      token: 'ghp_test',
      ref: 'main',
      path: 'docs/note.unknownext'
    })

    expect(result.contentType).toBe('application/vnd.github.raw; charset=utf-8')
  })

  it('falls back to the upstream content-type when the extension yields no useful MIME mapping', async () => {
    mockFetchOnce(
      new Response('???', {
        status: 200,
        headers: { 'content-type': 'application/vnd.github.raw; charset=utf-8' }
      })
    )

    const result = await fetchFileFromGitHub({
      repo: 'octocat/hello-world',
      token: 'ghp_test',
      ref: 'main',
      path: 'docs/note.unknownext'
    })

    expect(result.contentType).toBe('application/vnd.github.raw; charset=utf-8')
  })

  it('returns binary content as Uint8Array without UTF-8 corruption', async () => {
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0x80])
    mockFetchOnce(
      new Response(pngBytes, {
        status: 200,
        headers: { 'content-type': 'application/vnd.github.raw' }
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
    expect(result.contentType).toBe('image/png')
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
          commit: { sha: 'commit-sha', html_url: 'https://github.com/octocat/hello-world/commit/abc' },
          content: { sha: 'new-blob-sha' }
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

    expect(result.commitSha).toBe('commit-sha')
    expect(result.htmlUrl).toBe('https://github.com/octocat/hello-world/commit/abc')
    expect(result.contentSha).toBe('new-blob-sha')
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
      jsonResponse({ commit: { sha: 'c', html_url: 'u' }, content: { sha: 'blob' } }, { status: 200 })
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
      jsonResponse({ commit: { sha: 'c', html_url: 'u' }, content: { sha: 'blob' } }, { status: 200 })
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
        { commit: { sha: 'commit-sha', html_url: 'https://example/commit' }, content: { sha: 'new-blob-sha' } },
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

    expect(result.commitSha).toBe('commit-sha')
    expect(result.htmlUrl).toBe('https://example/commit')
    expect(result.branch).toBe('foo-draft')
    expect(result.contentSha).toBe('new-blob-sha')
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
      jsonResponse({ commit: { sha: 'c', html_url: 'u' }, content: { sha: 'b' } }, { status: 201 }) // commitFile
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
      jsonResponse({ commit: { sha: 'c', html_url: 'u' }, content: { sha: 'b' } }, { status: 201 })
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
      jsonResponse({ commit: { sha: 'c', html_url: 'u' }, content: { sha: 'b' } }, { status: 200 })
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

describe('parseIfMatch', () => {
  it('returns null when the header is null', () => {
    expect(parseIfMatch(null)).toBeNull()
  })

  it('returns null when the header is empty', () => {
    expect(parseIfMatch('')).toBeNull()
  })

  it('returns the inner SHA for a strong ETag', () => {
    expect(parseIfMatch('"abc123"')).toBe('abc123')
  })

  it('strips the W/ prefix from a weak ETag', () => {
    expect(parseIfMatch('W/"abc123"')).toBe('abc123')
  })

  it('returns the first tag from a comma-separated list', () => {
    expect(parseIfMatch('"first", "second"')).toBe('first')
  })

  it('returns the first tag when the list mixes weak and strong ETags', () => {
    expect(parseIfMatch('W/"first", "second"')).toBe('first')
  })

  it('trims surrounding whitespace', () => {
    expect(parseIfMatch('  W/"abc123"  ')).toBe('abc123')
  })

  it('returns the inner value when the ETag lacks quotes', () => {
    expect(parseIfMatch('abc123')).toBe('abc123')
  })
})

describe('commitFile contentSha', () => {
  const ORIGINAL_FETCH = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH
  })

  it('returns the new file blob SHA from content.sha in the GitHub response', async () => {
    mockFetchSequence([
      jsonResponse(
        {
          commit: { sha: 'commit-sha', html_url: 'https://example/commit' },
          content: { sha: 'new-blob-sha' }
        },
        { status: 201 }
      )
    ])

    const result = await commitFile({
      repo: 'octocat/hello-world',
      token: 'ghp_test',
      branch: 'foo-draft',
      path: 'foo/bar',
      message: 'Update',
      content: Buffer.from('hello').toString('base64')
    })

    expect(result.contentSha).toBe('new-blob-sha')
  })

  it('throws GitHubApiError when the response omits content.sha', async () => {
    mockFetchSequence([
      jsonResponse(
        { commit: { sha: 'commit-sha', html_url: 'https://example/commit' } },
        { status: 201 }
      )
    ])

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

describe('commitFileOnBranch contentSha', () => {
  const ORIGINAL_FETCH = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH
  })

  it('returns the new file blob SHA on the result', async () => {
    mockFetchSequence([
      jsonResponse({ object: { sha: 'branch-sha' } }, { status: 200 }), // getBranchRef
      new Response('Not Found', { status: 404 }),                       // getFileBlobSha
      jsonResponse(
        {
          commit: { sha: 'commit-sha', html_url: 'https://example/commit' },
          content: { sha: 'new-blob-sha' }
        },
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

    expect(result.contentSha).toBe('new-blob-sha')
  })
})

describe('listDirectoryFromGitHub', () => {
  const ORIGINAL_FETCH = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH
  })

  it('GETs the contents URL with Accept: application/vnd.github+json', async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse(
        [
          { name: 'a', path: 'foo/a', type: 'file', sha: 'sha-a' },
          { name: 'b', path: 'foo/b', type: 'dir', sha: 'sha-b' }
        ],
        { status: 200 }
      )
    ])

    const result = await listDirectoryFromGitHub({
      repo: 'octocat/hello-world',
      token: 'ghp_test',
      ref: 'main',
      path: 'foo'
    })

    expect(result.status).toBe(200)
    expect(result.entries).toEqual([
      { name: 'a', path: 'foo/a', type: 'file', sha: 'sha-a' },
      { name: 'b', path: 'foo/b', type: 'dir', sha: 'sha-b' }
    ])
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.github.com/repos/octocat/hello-world/contents/foo?ref=main')
    expect(init.method).toBe('GET')
    const headers = init.headers as Record<string, string>
    expect(headers['Accept']).toBe('application/vnd.github+json')
    expect(headers['Authorization']).toBe('Bearer ghp_test')
  })

  it('uses HEAD as the default ref when not provided', async () => {
    const fetchMock = mockFetchSequence([jsonResponse([], { status: 200 })])

    await listDirectoryFromGitHub({
      repo: 'octocat/hello-world',
      token: 'ghp_test',
      path: ''
    })

    const [url] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.github.com/repos/octocat/hello-world/contents/?ref=HEAD')
  })

  it('encodes path segments', async () => {
    const fetchMock = mockFetchSequence([jsonResponse([], { status: 200 })])

    await listDirectoryFromGitHub({
      repo: 'octocat/hello-world',
      token: 'ghp_test',
      ref: 'main',
      path: 'docs/read me'
    })

    const [url] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.github.com/repos/octocat/hello-world/contents/docs/read%20me?ref=main')
  })

  it('returns an empty entries list with status 404 when the directory does not exist', async () => {
    mockFetchSequence([new Response('Not Found', { status: 404 })])

    const result = await listDirectoryFromGitHub({
      repo: 'octocat/hello-world',
      token: 'ghp_test',
      ref: 'main',
      path: 'missing'
    })

    expect(result.status).toBe(404)
    expect(result.entries).toEqual([])
  })

  it('throws GitHubApiError on network failure', async () => {
    globalThis.fetch = vi.fn().mockRejectedValueOnce(new Error('network down')) as unknown as typeof fetch

    await expect(
      listDirectoryFromGitHub({
        repo: 'octocat/hello-world',
        token: 'ghp_test',
        ref: 'main',
        path: 'foo'
      })
    ).rejects.toBeInstanceOf(GitHubApiError)
  })

  it('throws GitHubApiError on 5xx upstream', async () => {
    mockFetchSequence([new Response('boom', { status: 502 })])

    await expect(
      listDirectoryFromGitHub({
        repo: 'octocat/hello-world',
        token: 'ghp_test',
        ref: 'main',
        path: 'foo'
      })
    ).rejects.toBeInstanceOf(GitHubApiError)
  })

  it('throws GitHubApiError on a 422 client error', async () => {
    mockFetchSequence([new Response('Unprocessable', { status: 422 })])

    await expect(
      listDirectoryFromGitHub({
        repo: 'octocat/hello-world',
        token: 'ghp_test',
        ref: 'main',
        path: 'bad..name'
      })
    ).rejects.toBeInstanceOf(GitHubApiError)
  })

  it('returns an empty listing (offline mode) when token is dummy', async () => {
    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    const result = await listDirectoryFromGitHub({
      repo: 'octocat/hello-world',
      token: 'dummy',
      ref: 'HEAD',
      path: ''
    })

    expect(result.status).toBe(404)
    expect(result.entries).toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('preserves the entry type from GitHub (file, dir, symlink, submodule)', async () => {
    mockFetchSequence([
      jsonResponse(
        [
          { name: 'a', path: 'p/a', type: 'file', sha: 'sha-a' },
          { name: 'b', path: 'p/b', type: 'dir', sha: 'sha-b' },
          { name: 'c', path: 'p/c', type: 'symlink', sha: 'sha-c' },
          { name: 'd', path: 'p/d', type: 'submodule', sha: 'sha-d' }
        ],
        { status: 200 }
      )
    ])

    const result = await listDirectoryFromGitHub({
      repo: 'octocat/hello-world',
      token: 'ghp_test',
      ref: 'main',
      path: 'p'
    })

    expect(result.entries.map((e) => e.type)).toEqual(['file', 'dir', 'symlink', 'submodule'])
  })
})

describe('listCommitsForPath', () => {
  const ORIGINAL_FETCH = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH
  })

  it('builds the commits URL with owner, repo, sha, path, per_page, and page params', async () => {
    const fetchMock = mockFetchSequence([jsonResponse([], { status: 200 })])

    await listCommitsForPath({
      repo: 'octocat/hello-world',
      token: 'ghp_test',
      branch: 'main',
      path: 'foo',
      perPage: 30,
      page: 1
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(
      'https://api.github.com/repos/octocat/hello-world/commits?sha=main&path=foo&per_page=30&page=1'
    )
    expect(init.method).toBe('GET')
    const headers = init.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer ghp_test')
    expect(headers['Accept']).toBe('application/vnd.github+json')
    expect(headers['X-GitHub-Api-Version']).toBe('2022-11-28')
    expect(headers['User-Agent']).toBe('solid-github-netlify'
    )
  })

  it('omits per_page and page when not provided', async () => {
    const fetchMock = mockFetchSequence([jsonResponse([], { status: 200 })])

    await listCommitsForPath({
      repo: 'octocat/hello-world',
      token: 'ghp_test',
      branch: 'main',
      path: 'foo'
    })

    const [url] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.github.com/repos/octocat/hello-world/commits?sha=main&path=foo')
    expect(url).not.toContain('per_page')
    expect(url).not.toContain('page=')
  })

  it('appends since and until query params when provided', async () => {
    const fetchMock = mockFetchSequence([jsonResponse([], { status: 200 })])

    await listCommitsForPath({
      repo: 'octocat/hello-world',
      token: 'ghp_test',
      branch: 'main',
      path: 'foo',
      since: '2024-01-01T00:00:00Z',
      until: '2024-12-31T23:59:59Z'
    })

    const [url] = fetchMock.mock.calls[0]
    expect(url).toContain('since=2024-01-01T00%3A00%3A00Z')
    expect(url).toContain('until=2024-12-31T23%3A59%3A59Z')
  })

  it('encodes path segments in the path query param', async () => {
    const fetchMock = mockFetchSequence([jsonResponse([], { status: 200 })])

    await listCommitsForPath({
      repo: 'octocat/hello-world',
      token: 'ghp_test',
      branch: 'main',
      path: 'docs/read me'
    })

    const [url] = fetchMock.mock.calls[0]
    expect(url).toMatch(/path=docs(%2F|\/)read(\+|%20)me/)
  })

  it('parses a commit list response into normalised Commit[]', async () => {
    mockFetchSequence([
      jsonResponse(
        [
          {
            sha: 'abc12345',
            commit: {
              message: 'First commit',
              author: { name: 'Alice', email: 'alice@example.com', date: '2024-01-15T10:00:00Z' }
            },
            author: { login: 'alice' },
            html_url: 'https://github.com/octocat/hello-world/commit/abc12345'
          },
          {
            sha: 'def67890',
            commit: {
              message: 'Second commit',
              author: { name: 'Bob', email: 'bob@example.com', date: '2024-02-20T12:00:00Z' }
            },
            html_url: 'https://github.com/octocat/hello-world/commit/def67890'
          }
        ],
        { status: 200 }
      )
    ])

    const result = await listCommitsForPath({
      repo: 'octocat/hello-world',
      token: 'ghp_test',
      branch: 'main',
      path: 'foo'
    })

    expect(result).toEqual([
      {
        sha: 'abc12345',
        message: 'First commit',
        authorName: 'Alice',
        authorEmail: 'alice@example.com',
        authorLogin: 'alice',
        date: '2024-01-15T10:00:00Z',
        htmlUrl: 'https://github.com/octocat/hello-world/commit/abc12345'
      },
      {
        sha: 'def67890',
        message: 'Second commit',
        authorName: 'Bob',
        authorEmail: 'bob@example.com',
        authorLogin: undefined,
        date: '2024-02-20T12:00:00Z',
        htmlUrl: 'https://github.com/octocat/hello-world/commit/def67890'
      }
    ])
  })

  it('returns an empty array on a 200 with empty body', async () => {
    mockFetchSequence([jsonResponse([], { status: 200 })])

    const result = await listCommitsForPath({
      repo: 'octocat/hello-world',
      token: 'ghp_test',
      branch: 'main',
      path: 'foo'
    })

    expect(result).toEqual([])
  })

  it('returns an empty array on a 404 (no commits for the path)', async () => {
    mockFetchSequence([new Response('Not Found', { status: 404 })])

    const result = await listCommitsForPath({
      repo: 'octocat/hello-world',
      token: 'ghp_test',
      branch: 'main',
      path: 'missing'
    })

    expect(result).toEqual([])
  })

  it('throws GitHubApiError on 5xx upstream', async () => {
    mockFetchSequence([new Response('boom', { status: 502 })])

    await expect(
      listCommitsForPath({
        repo: 'octocat/hello-world',
        token: 'ghp_test',
        branch: 'main',
        path: 'foo'
      })
    ).rejects.toBeInstanceOf(GitHubApiError)
  })

  it('throws GitHubApiError on 4xx other than 404', async () => {
    mockFetchSequence([new Response('Unprocessable', { status: 422 })])

    await expect(
      listCommitsForPath({
        repo: 'octocat/hello-world',
        token: 'ghp_test',
        branch: 'main',
        path: 'foo'
      })
    ).rejects.toBeInstanceOf(GitHubApiError)
  })

  it('throws GitHubApiError on network failure', async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('network down')) as unknown as typeof fetch

    await expect(
      listCommitsForPath({
        repo: 'octocat/hello-world',
        token: 'ghp_test',
        branch: 'main',
        path: 'foo'
      })
    ).rejects.toBeInstanceOf(GitHubApiError)
  })
})

describe('listFolderContentsAtCommit', () => {
  const ORIGINAL_FETCH = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH
  })

  it('builds the contents URL with ref set to the commit SHA and folder path', async () => {
    const fetchMock = mockFetchSequence([jsonResponse([], { status: 200 })])

    await listFolderContentsAtCommit({
      repo: 'octocat/hello-world',
      token: 'ghp_test',
      sha: 'abc1234567890abcdef1234567890abcdef12345',
      folder: 'foo'
    })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(
      'https://api.github.com/repos/octocat/hello-world/contents/foo?ref=abc1234567890abcdef1234567890abcdef12345'
    )
    const headers = init.headers as Record<string, string>
    expect(headers['Accept']).toBe('application/vnd.github+json')
    expect(headers['Authorization']).toBe('Bearer ghp_test')
  })

  it('encodes folder path segments', async () => {
    const fetchMock = mockFetchSequence([jsonResponse([], { status: 200 })])

    await listFolderContentsAtCommit({
      repo: 'octocat/hello-world',
      token: 'ghp_test',
      sha: 'abc12345',
      folder: 'docs/read me'
    })

    const [url] = fetchMock.mock.calls[0]
    expect(url).toContain('/contents/docs/read%20me?ref=abc12345')
  })

  it('parses the immediate children of the folder at the given commit', async () => {
    mockFetchSequence([
      jsonResponse(
        [
          { name: 'index.html', path: 'foo/index.html', type: 'file', sha: 'sha-1' },
          { name: 'blog', path: 'foo/blog', type: 'dir', sha: 'sha-2' }
        ],
        { status: 200 }
      )
    ])

    const result = await listFolderContentsAtCommit({
      repo: 'octocat/hello-world',
      token: 'ghp_test',
      sha: 'abc12345',
      folder: 'foo'
    })

    expect(result.status).toBe(200)
    expect(result.entries).toEqual([
      { name: 'index.html', path: 'foo/index.html', type: 'file', sha: 'sha-1' },
      { name: 'blog', path: 'foo/blog', type: 'dir', sha: 'sha-2' }
    ])
  })

  it('returns only immediate children: nested paths from a recursive tree are NOT included', async () => {
    mockFetchSequence([
      jsonResponse(
        [
          { name: 'index.html', path: 'foo/index.html', type: 'file', sha: 'sha-1' },
          { name: 'blog', path: 'foo/blog', type: 'dir', sha: 'sha-2' }
        ],
        { status: 200 }
      )
    ])

    const result = await listFolderContentsAtCommit({
      repo: 'octocat/hello-world',
      token: 'ghp_test',
      sha: 'abc12345',
      folder: 'foo'
    })

    const childPaths = result.entries.map((e) => e.path)
    expect(childPaths).not.toContain('foo/blog/post.md')
    expect(childPaths).not.toContain('foo/blog/2024/index.md')
    expect(childPaths.every((p) => p.startsWith('foo/'))).toBe(true)
  })

  it('returns status 404 with empty entries when the folder does not exist at the commit', async () => {
    mockFetchSequence([new Response('Not Found', { status: 404 })])

    const result = await listFolderContentsAtCommit({
      repo: 'octocat/hello-world',
      token: 'ghp_test',
      sha: 'abc12345',
      folder: 'missing'
    })

    expect(result.status).toBe(404)
    expect(result.entries).toEqual([])
  })

  it('throws GitHubApiError on 5xx upstream', async () => {
    mockFetchSequence([new Response('boom', { status: 502 })])

    await expect(
      listFolderContentsAtCommit({
        repo: 'octocat/hello-world',
        token: 'ghp_test',
        sha: 'abc12345',
        folder: 'foo'
      })
    ).rejects.toBeInstanceOf(GitHubApiError)
  })

  it('throws GitHubApiError on 4xx other than 404', async () => {
    mockFetchSequence([new Response('Unprocessable', { status: 422 })])

    await expect(
      listFolderContentsAtCommit({
        repo: 'octocat/hello-world',
        token: 'ghp_test',
        sha: 'abc12345',
        folder: 'foo'
      })
    ).rejects.toBeInstanceOf(GitHubApiError)
  })

  it('throws GitHubApiError on network failure', async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('network down')) as unknown as typeof fetch

    await expect(
      listFolderContentsAtCommit({
        repo: 'octocat/hello-world',
        token: 'ghp_test',
        sha: 'abc12345',
        folder: 'foo'
      })
    ).rejects.toBeInstanceOf(GitHubApiError)
  })
})
