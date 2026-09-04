import mime from 'mime-types'

export interface FetchFileFromGitHubOptions {
  repo: string
  token: string
  ref?: string
  path: string
  ifNoneMatch?: string
  logTag?: string
}

const TEXT_MIME_TYPES = new Set([
  'application/json',
  'application/javascript',
  'application/xml',
  'application/xhtml+xml',
  'image/svg+xml'
])

function contentTypeFromPath(path: string): string | null {
  const type = mime.lookup(path)
  if (!type) return null
  if (type.startsWith('text/') || TEXT_MIME_TYPES.has(type)) {
    return `${type}; charset=utf-8`
  }
  return type
}

export interface GitHubFileResult {
  status: number
  body: Uint8Array
  contentType: string | null
  etag: string | null
  cacheControl: string | null
}

export class GitHubFetchError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'GitHubFetchError'
    this.status = status
  }
}

export class GitHubApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'GitHubApiError'
    this.status = status
  }
}

export function isPathSafe(path: string): boolean {
  if (!path) return false
  if (path.startsWith('/')) return false
  const segments = path.split('/')
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return false
    if (segment.includes('\0')) return false
  }
  return true
}

export function parseIfMatch(header: string | null | undefined): string | null {
  if (!header) return null
  const first = header.split(',')[0]?.trim()
  if (!first) return null
  let value = first
  if (value.startsWith('W/')) value = value.slice(2)
  if (value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1)
  }
  return value || null
}

export async function fetchFileFromGitHub(
  options: FetchFileFromGitHubOptions
): Promise<GitHubFileResult> {
  const ref = options.ref || 'HEAD'
  const url = buildContentsUrl(options.repo, ref, options.path)
  const headers = jsonHeaders(options.token)
  headers['Accept'] = 'application/vnd.github.raw'
  if (options.ifNoneMatch) {
    headers['If-None-Match'] = options.ifNoneMatch
  }

  console.log(`[github] GET ${url}${options.logTag ? ` (${options.logTag})` : ''}`)

  if (options.token === 'dummy') {
    return {
      status: 404,
      body: new Uint8Array(),
      contentType: null,
      etag: null,
      cacheControl: null,
    }
  }

  const response = await githubFetch(url, { method: 'GET', headers }, GitHubFetchError)

  const body = new Uint8Array(await response.arrayBuffer())
  return {
    status: response.status,
    body,
    contentType: contentTypeFromPath(options.path) ?? response.headers.get('content-type'),
    etag: response.headers.get('etag'),
    cacheControl: response.headers.get('cache-control')
  }
}

export interface ListDirectoryFromGitHubOptions {
  repo: string
  token: string
  ref?: string
  path: string
  logTag?: string
}

export interface GitHubDirectoryEntry {
  name: string
  path: string
  type: string
  sha: string
}

export interface GitHubDirectoryResult {
  status: number
  entries: GitHubDirectoryEntry[]
}

export async function listDirectoryFromGitHub(
  options: ListDirectoryFromGitHubOptions
): Promise<GitHubDirectoryResult> {
  const ref = options.ref || 'HEAD'
  const url = buildContentsUrl(options.repo, ref, options.path)
  const headers = jsonHeaders(options.token)

  console.log(`[github] GET ${url}${options.logTag ? ` (${options.logTag})` : ''}`)

  if (options.token === 'dummy') {
    return { status: 404, entries: [] }
  }

  const response = await githubFetch(url, { method: 'GET', headers }, GitHubApiError)
  if (response.status === 404) {
    return { status: 404, entries: [] }
  }
  const data = (await response.json()) as Array<{
    name?: string
    path?: string
    type?: string
    sha?: string
  }>
  if (!Array.isArray(data)) {
    throw new GitHubFetchError('GitHub directory response was not an array', 502)
  }
  const entries: GitHubDirectoryEntry[] = data
    .filter((e) => typeof e.name === 'string' && typeof e.path === 'string')
    .map((e) => ({
      name: e.name as string,
      path: e.path as string,
      type: typeof e.type === 'string' ? e.type : 'file',
      sha: typeof e.sha === 'string' ? e.sha : '',
    }))
  return { status: response.status, entries }
}

export interface ListFolderContentsAtCommitOptions {
  repo: string
  token: string
  sha: string
  folder: string
}

export async function listFolderContentsAtCommit(
  options: ListFolderContentsAtCommitOptions
): Promise<GitHubDirectoryResult> {
  return listDirectoryFromGitHub({
    repo: options.repo,
    token: options.token,
    ref: options.sha,
    path: options.folder
  })
}

function jsonHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'solid-github-netlify'
  }
}

async function githubFetch(
  url: string,
  init: RequestInit,
  Ctor: new (message: string, status: number) => Error
): Promise<Response> {
  let response: Response
  try {
    response = await fetch(url, init)
  } catch (error) {
    throw new Ctor(
      `GitHub request failed: ${error instanceof Error ? error.message : String(error)}`,
      502
    )
  }

  if (response.status === 404) {
    return response
  }

  if (response.status >= 500) {
    throw new Ctor(`GitHub upstream returned ${response.status}`, response.status)
  }

  if (response.status >= 400) {
    const message = await response.text().catch(() => '')
    throw new Ctor(
      `GitHub request failed (${response.status}): ${message || response.statusText}`,
      response.status
    )
  }

  return response
}

export interface GetBranchRefOptions {
  repo: string
  token: string
  branch: string
}

export async function getBranchRef(options: GetBranchRefOptions): Promise<string | null> {
  const url = `https://api.github.com/repos/${options.repo}/git/ref/heads/${encodeBranch(options.branch)}`
  const response = await githubFetch(
    url,
    { method: 'GET', headers: jsonHeaders(options.token) },
    GitHubApiError
  )

  if (response.status === 404) {
    return null
  }

  const data = (await response.json()) as { object?: { sha?: string } }
  return data.object?.sha ?? null
}

export interface GetDefaultBranchOptions {
  repo: string
  token: string
}

export async function getDefaultBranch(options: GetDefaultBranchOptions): Promise<string> {
  const url = `https://api.github.com/repos/${options.repo}`
  const response = await githubFetch(
    url,
    { method: 'GET', headers: jsonHeaders(options.token) },
    GitHubApiError
  )

  const data = (await response.json()) as { default_branch?: string }
  if (!data.default_branch) {
    throw new GitHubApiError('GitHub response missing default_branch', 502)
  }
  return data.default_branch
}

export interface CreateBranchFromShaOptions {
  repo: string
  token: string
  branch: string
  sha: string
}

export async function createBranchFromSha(options: CreateBranchFromShaOptions): Promise<void> {
  const url = `https://api.github.com/repos/${options.repo}/git/refs`
  const headers = jsonHeaders(options.token)
  headers['Content-Type'] = 'application/json'
  const body = JSON.stringify({ ref: `refs/heads/${options.branch}`, sha: options.sha })

  await githubFetch(url, { method: 'POST', headers, body }, GitHubApiError)
}

export interface GetFileBlobShaOptions {
  repo: string
  token: string
  ref: string
  path: string
}

export async function getFileBlobSha(options: GetFileBlobShaOptions): Promise<string | null> {
  const url = `https://api.github.com/repos/${options.repo}/contents/${encodePath(options.path)}?ref=${encodeURIComponent(options.ref)}`
  const response = await githubFetch(
    url,
    { method: 'GET', headers: jsonHeaders(options.token) },
    GitHubApiError
  )

  if (response.status === 404) {
    return null
  }

  const data = (await response.json()) as { sha?: string }
  return data.sha ?? null
}

export interface CommitFileOptions {
  repo: string
  token: string
  branch: string
  path: string
  message: string
  content: string
  sha?: string
}

export interface CommitFileResult {
  commitSha: string
  htmlUrl: string
  contentSha: string
}

export async function commitFile(options: CommitFileOptions): Promise<CommitFileResult> {
  const url = `https://api.github.com/repos/${options.repo}/contents/${encodePath(options.path)}`
  const headers = jsonHeaders(options.token)
  headers['Content-Type'] = 'application/json'
  const body = JSON.stringify({
    message: options.message,
    content: options.content,
    branch: options.branch,
    ...(options.sha ? { sha: options.sha } : {})
  })

  const response = await githubFetch(url, { method: 'PUT', headers, body }, GitHubApiError)
  const data = (await response.json()) as {
    commit?: { sha?: string; html_url?: string }
    content?: { sha?: string }
  }
  const sha = data.commit?.sha
  const htmlUrl = data.commit?.html_url
  const contentSha = data.content?.sha
  if (!sha || !htmlUrl) {
    throw new GitHubApiError('GitHub response missing commit.sha/html_url', 502)
  }
  if (!contentSha) {
    throw new GitHubApiError('GitHub response missing content.sha', 502)
  }
  return { commitSha: sha, htmlUrl, contentSha }
}

export interface CommitFileOnBranchOptions {
  repo: string
  token: string
  baseRef: string
  branch: string
  path: string
  content: string
  message: string
  ifMatch?: string
}

export async function commitFileOnBranch(
  options: CommitFileOnBranchOptions
): Promise<CommitFileResult & { branch: string }> {
  const branchSha = await getBranchRef({
    repo: options.repo,
    token: options.token,
    branch: options.branch
  })

  if (!branchSha) {
    const baseRef = options.baseRef === 'HEAD'
      ? await getDefaultBranch({ repo: options.repo, token: options.token })
      : options.baseRef
    const baseSha = await getBranchRef({
      repo: options.repo,
      token: options.token,
      branch: baseRef
    })
    if (!baseSha) {
      throw new GitHubApiError(`Base ref ${baseRef} not found`, 404)
    }
    await createBranchFromSha({
      repo: options.repo,
      token: options.token,
      branch: options.branch,
      sha: baseSha
    })
  }

  const fileSha = await getFileBlobSha({
    repo: options.repo,
    token: options.token,
    ref: options.branch,
    path: options.path
  })

  const shaToSend = options.ifMatch ?? fileSha ?? undefined

  const result = await commitFile({
    repo: options.repo,
    token: options.token,
    branch: options.branch,
    path: options.path,
    message: options.message,
    content: options.content,
    ...(shaToSend ? { sha: shaToSend } : {})
  })

  return { ...result, branch: options.branch }
}

function encodePath(path: string): string {
  return path.split('/').map((segment) => encodeURIComponent(segment)).join('/')
}

function encodeBranch(branch: string): string {
  return branch
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

function buildContentsUrl(repo: string, ref: string, path: string): string {
  const encoded = encodePath(path)
  return `https://api.github.com/repos/${repo}/contents/${encoded}?ref=${encodeURIComponent(ref)}`
}

export interface ListCommitsForPathOptions {
  repo: string
  token: string
  branch: string
  path: string
  perPage?: number
  page?: number
  since?: string
  until?: string
}

export interface Commit {
  sha: string
  message: string
  authorName: string
  authorEmail: string
  authorLogin?: string
  date: string
  htmlUrl: string
}

export async function listCommitsForPath(
  options: ListCommitsForPathOptions
): Promise<Commit[]> {
  if (options.token === 'dummy') {
    return []
  }
  const url = buildCommitsUrl(options)
  const headers = jsonHeaders(options.token)
  headers['Accept'] = 'application/vnd.github+json'

  const response = await githubFetch(url, { method: 'GET', headers }, GitHubApiError)

  if (response.status === 404) {
    return []
  }

  const data = (await response.json()) as Array<{
    sha?: string
    commit?: {
      message?: string
      author?: { name?: string; email?: string; date?: string }
    }
    author?: { login?: string } | null
    html_url?: string
  }>

  if (!Array.isArray(data)) {
    return []
  }

  return data
    .filter((c) => typeof c.sha === 'string')
    .map((c) => ({
      sha: c.sha as string,
      message: c.commit?.message ?? '',
      authorName: c.commit?.author?.name ?? '',
      authorEmail: c.commit?.author?.email ?? '',
      authorLogin:
        c.author && typeof c.author === 'object' && typeof c.author.login === 'string'
          ? c.author.login
          : undefined,
      date: c.commit?.author?.date ?? '',
      htmlUrl: c.html_url ?? ''
    }))
}

function buildCommitsUrl(options: ListCommitsForPathOptions): string {
  const params = new URLSearchParams()
  params.set('sha', options.branch)
  params.set('path', options.path)
  if (typeof options.perPage === 'number') params.set('per_page', String(options.perPage))
  if (typeof options.page === 'number') params.set('page', String(options.page))
  if (typeof options.since === 'string') params.set('since', options.since)
  if (typeof options.until === 'string') params.set('until', options.until)
  return `https://api.github.com/repos/${options.repo}/commits?${params.toString()}`
}
