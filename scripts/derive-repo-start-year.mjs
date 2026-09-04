#!/usr/bin/env node
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const DEFAULT_OUTPUT = join(
  __dirname,
  '..',
  'netlify',
  'functions',
  'router',
  'repo-start-year.generated.mjs'
)

const MIN_YEAR = 1900
const MAX_YEAR = 2100

/**
 * @typedef {Object} DeriveOptions
 * @property {Record<string, string | undefined>=} env
 * @property {typeof fetch=} fetchImpl
 * @property {string=} outputPath
 * @property {(msg: string) => void=} log
 * @property {(msg: string) => void=} warn
 * @property {(msg: string) => void=} error
 *
 * @typedef {Object} DeriveResult
 * @property {'written' | 'skipped' | 'failed'} status
 * @property {number=} year
 * @property {string=} path
 * @property {string=} reason
 * @property {'user' | 'public' | 'auth' | 'placeholder'=} source
 */

function looksLikeMaskedToken(value) {
  return typeof value === 'string' && value.length > 0 && /[*]/.test(value)
}

function parseUserYear(raw) {
  if (typeof raw !== 'string' || raw === '') return null
  const trimmed = raw.trim()
  if (trimmed === '') return null
  if (!/^\d+$/.test(trimmed)) return null
  const n = Number.parseInt(trimmed, 10)
  if (!Number.isFinite(n) || n < MIN_YEAR || n > MAX_YEAR) return null
  return n
}

function writeYearFile(target, year, source) {
  mkdirSync(dirname(target), { recursive: true })
  const header =
    source === 'user'
      ? `// Auto-generated at build time by scripts/derive-repo-start-year.mjs.\n` +
        `// Source: user-supplied REPO_START_YEAR env var.\n`
      : source === 'public'
        ? `// Auto-generated at build time by scripts/derive-repo-start-year.mjs.\n` +
          `// Source: public GitHub API (no auth).\n`
        : source === 'auth'
          ? `// Auto-generated at build time by scripts/derive-repo-start-year.mjs.\n` +
            `// Source: authenticated GitHub API.\n`
          : `// Auto-generated at build time by scripts/derive-repo-start-year.mjs.\n` +
            `// Placeholder — see [derive-repo-start-year] log for context.\n`
  writeFileSync(target, header + `export const REPO_START_YEAR = ${year};\n`)
}

async function fetchRepoMeta(repo, headers, fetchImpl) {
  const url = `https://api.github.com/repos/${repo}`
  return fetchImpl(url, { headers })
}

async function readErrorDetail(response) {
  let detail = ''
  try {
    const raw = (await response.text()).slice(0, 500)
    if (raw) {
      let message = raw
      try {
        const parsed = JSON.parse(raw)
        if (
          parsed &&
          typeof parsed.message === 'string' &&
          parsed.message
        ) {
          message = parsed.message
        }
      } catch {
        // not JSON; keep raw text
      }
      detail = `: ${message}`
    }
  } catch {
    // body unreadable
  }
  return detail
}

function logApiFailure(response, repo, errorFn) {
  return readErrorDetail(response).then((detail) => {
    errorFn(
      `[derive-repo-start-year] GitHub API returned ${response.status} for ${repo}${detail}.`
    )
  })
}

/**
 * @param {DeriveOptions} [opts]
 * @returns {Promise<DeriveResult>}
 */
export async function deriveRepoStartYear(opts = {}) {
  const env = opts.env ?? process.env
  const fetchImpl = opts.fetchImpl ?? fetch
  const log = opts.log ?? ((m) => console.log(m))
  const warn = opts.warn ?? ((m) => console.warn(m))
  const errorFn = opts.error ?? ((m) => console.error(m))
  const target = opts.outputPath ?? DEFAULT_OUTPUT

  const userYearRaw = env.REPO_START_YEAR
  if (userYearRaw !== undefined && userYearRaw !== '') {
    const parsed = parseUserYear(userYearRaw)
    if (parsed === null) {
      errorFn(
        `[derive-repo-start-year] REPO_START_YEAR must be a 4-digit year between ${MIN_YEAR} and ${MAX_YEAR}; got "${userYearRaw}".`
      )
      return { status: 'failed', reason: 'bad-user-year' }
    }
    writeYearFile(target, parsed, 'user')
    log(
      `[derive-repo-start-year] REPO_START_YEAR=${parsed} (from user env REPO_START_YEAR)`
    )
    return {
      status: 'written',
      year: parsed,
      path: target,
      source: 'user',
    }
  }

  const repo = env.GITHUB_REPO
  if (!repo) {
    warn(
      '[derive-repo-start-year] REPO_START_YEAR and GITHUB_REPO not set; writing placeholder REPO_START_YEAR=0.'
    )
    writeYearFile(target, 0, 'placeholder')
    return {
      status: 'skipped',
      reason: 'missing-repo',
      year: 0,
      path: target,
      source: 'placeholder',
    }
  }

  const slashIdx = repo.indexOf('/')
  if (
    slashIdx < 1 ||
    slashIdx === repo.length - 1 ||
    repo.indexOf('/', slashIdx + 1) !== -1
  ) {
    errorFn(
      `[derive-repo-start-year] GITHUB_REPO must be in owner/repo form; got "${repo}".`
    )
    return { status: 'failed', reason: 'bad-repo-format' }
  }

  const publicHeaders = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'solid-github-netlify',
  }

  const publicResponse = await fetchRepoMeta(repo, publicHeaders, fetchImpl)
  if (publicResponse.ok) {
    let data
    try {
      data = await publicResponse.json()
    } catch {
      data = null
    }
    if (data && typeof data.created_at === 'string') {
      const year = new Date(data.created_at).getUTCFullYear()
      if (Number.isFinite(year)) {
        writeYearFile(target, year, 'public')
        log(
          `[derive-repo-start-year] REPO_START_YEAR=${year} (public resolution of ${repo})`
        )
        return {
          status: 'written',
          year,
          path: target,
          source: 'public',
        }
      }
    }
  }

  const token = env.GITHUB_TOKEN
  if (token !== undefined && token !== '' && looksLikeMaskedToken(token)) {
    const preview =
      token.length <= 6
        ? token
        : `${token.slice(0, 4)}…${token.slice(-2)} (${token.length} chars)`
    errorFn(
      `[derive-repo-start-year] GITHUB_TOKEN appears to be the Netlify CLI's masked placeholder (preview: ${preview}). Local \`netlify deploy\` cannot read --secret vars, and public resolution of ${repo} failed. Set REPO_START_YEAR=<year> directly to bypass the API call, or re-set GITHUB_TOKEN without --secret (\`netlify env:set GITHUB_TOKEN <pat>\`).`
    )
    return { status: 'failed', reason: 'masked-token' }
  }

  if (!token) {
    warn(
      `[derive-repo-start-year] Public resolution of ${repo} failed and no GITHUB_TOKEN is set; writing placeholder REPO_START_YEAR=0. Set REPO_START_YEAR=<year> to bypass the API call.`
    )
    writeYearFile(target, 0, 'placeholder')
    return {
      status: 'skipped',
      reason: 'public-failed-no-token',
      year: 0,
      path: target,
      source: 'placeholder',
    }
  }

  const authHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'solid-github-netlify',
  }
  const authResponse = await fetchRepoMeta(repo, authHeaders, fetchImpl)

  if (!authResponse.ok) {
    await logApiFailure(authResponse, repo, errorFn)
    return { status: 'failed', reason: `http-${authResponse.status}` }
  }

  const data = await authResponse.json()
  if (typeof data.created_at !== 'string') {
    errorFn(
      '[derive-repo-start-year] GitHub response missing created_at field.'
    )
    return { status: 'failed', reason: 'missing-created-at' }
  }

  const year = new Date(data.created_at).getUTCFullYear()
  if (!Number.isFinite(year)) {
    errorFn(
      `[derive-repo-start-year] Could not parse year from created_at: ${data.created_at}`
    )
    return { status: 'failed', reason: 'bad-created-at' }
  }

  writeYearFile(target, year, 'auth')
  log(`[derive-repo-start-year] REPO_START_YEAR=${year} (auth API, from ${repo})`)
  return {
    status: 'written',
    year,
    path: target,
    source: 'auth',
  }
}

const isMain = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}`
  } catch {
    return false
  }
})()

if (isMain) {
  deriveRepoStartYear().then((r) => {
    if (r.status === 'failed') process.exit(1)
    process.exit(0)
  })
}