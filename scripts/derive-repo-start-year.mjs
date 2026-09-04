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
 */

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

  const repo = env.GITHUB_REPO
  const token = env.GITHUB_TOKEN

  if (!repo || !token) {
    warn(
      '[derive-repo-start-year] GITHUB_REPO and/or GITHUB_TOKEN not set; writing placeholder REPO_START_YEAR=0.'
    )
    const target = opts.outputPath ?? DEFAULT_OUTPUT
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(
      target,
      `// Auto-generated at build time by scripts/derive-repo-start-year.mjs.\n` +
        `// Placeholder — set GITHUB_REPO and GITHUB_TOKEN to derive the real year.\n` +
        `export const REPO_START_YEAR = 0;\n`
    )
    return { status: 'skipped', reason: 'missing-env', year: 0, path: target }
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

  const url = `https://api.github.com/repos/${repo}`
  const response = await fetchImpl(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'solid-github-netlify',
    },
  })

  if (!response.ok) {
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
    errorFn(
      `[derive-repo-start-year] GitHub API returned ${response.status} for ${repo}${detail}.`
    )
    return { status: 'failed', reason: `http-${response.status}` }
  }

  const data = await response.json()
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

  const target = opts.outputPath ?? DEFAULT_OUTPUT
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(
    target,
    `// Auto-generated at build time by scripts/derive-repo-start-year.mjs.\n` +
      `// Do not edit by hand.\n` +
      `export const REPO_START_YEAR = ${year};\n`
  )

  log(`[derive-repo-start-year] REPO_START_YEAR=${year} (from ${repo})`)
  return { status: 'written', year, path: target }
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
