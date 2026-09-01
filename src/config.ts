export interface WriteConfig {
  writeWebIds: string[]
}

export interface GithubConfig {
  githubRepo: string
  githubToken: string
  githubRef: string
}

export function loadWriteConfig(): WriteConfig {
  const raw = process.env.WRITE_WEBIDS
  if (!raw) {
    throw new Error('WRITE_WEBIDS is required')
  }
  const writeWebIds = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  if (writeWebIds.length === 0) {
    throw new Error('WRITE_WEBIDS is required')
  }
  return { writeWebIds }
}

export function loadGithubConfig(): GithubConfig {
  const githubRepo = (process.env.GITHUB_REPO ?? '').trim()
  if (!githubRepo) {
    throw new Error('GITHUB_REPO is required')
  }
  if (!/^[^/\s]+\/[^/\s]+$/.test(githubRepo)) {
    throw new Error('GITHUB_REPO must be in owner/repo form')
  }

  const githubToken = (process.env.GITHUB_TOKEN ?? '').trim()
  if (!githubToken) {
    throw new Error('GITHUB_TOKEN is required')
  }

  const githubRef = (process.env.GITHUB_REF ?? 'HEAD').trim() || 'HEAD'

  return { githubRepo, githubToken, githubRef }
}

export interface Config extends WriteConfig, GithubConfig {}

export function loadConfig(): Config {
  return { ...loadWriteConfig(), ...loadGithubConfig() }
}
