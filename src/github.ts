export interface FetchFileFromGitHubOptions {
  repo: string
  token: string
  ref?: string
  path: string
  ifNoneMatch?: string
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

export async function fetchFileFromGitHub(
  options: FetchFileFromGitHubOptions
): Promise<GitHubFileResult> {
  const ref = options.ref || 'HEAD'
  const url = buildContentsUrl(options.repo, ref, options.path)
  const headers: Record<string, string> = {
    Authorization: `Bearer ${options.token}`,
    Accept: 'application/vnd.github.raw',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'solid-github-netlify'
  }
  if (options.ifNoneMatch) {
    headers['If-None-Match'] = options.ifNoneMatch
  }

  let response: Response
  try {
    response = await fetch(url, { method: 'GET', headers })
  } catch (error) {
    throw new GitHubFetchError(
      `GitHub fetch failed: ${error instanceof Error ? error.message : String(error)}`,
      502
    )
  }

  if (response.status >= 500) {
    throw new GitHubFetchError(`GitHub upstream returned ${response.status}`, 502)
  }

  const body = new Uint8Array(await response.arrayBuffer())
  return {
    status: response.status,
    body,
    contentType: response.headers.get('content-type'),
    etag: response.headers.get('etag'),
    cacheControl: response.headers.get('cache-control')
  }
}

function buildContentsUrl(repo: string, ref: string, path: string): string {
  const encoded = path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
  return `https://api.github.com/repos/${repo}/contents/${encoded}?ref=${encodeURIComponent(ref)}`
}
