import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

import { deriveRepoStartYear } from '../../scripts/derive-repo-start-year.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const REPO_ROOT = join(__dirname, '..', '..')
const GENERATED = join(
  REPO_ROOT,
  'netlify',
  'functions',
  'router',
  'repo-start-year.generated.mjs'
)

function makeTempDir(): string {
  return join(
    tmpdir(),
    `build-config-${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
}

function tempOutput(): string {
  return join(makeTempDir(), 'repo-start-year.generated.mjs')
}

type LogFn = (msg: string) => void
type Spy = ReturnType<typeof vi.fn> & LogFn

function makeSpy(): Spy {
  return vi.fn() as Spy
}

describe('deriveRepoStartYear', () => {
  let logSpy: Spy
  let warnSpy: Spy
  let errorSpy: Spy

  beforeEach(() => {
    logSpy = makeSpy()
    warnSpy = makeSpy()
    errorSpy = makeSpy()
  })

  afterEach(() => {
    if (existsSync(GENERATED)) {
      rmSync(GENERATED, { force: true })
    }
  })

  describe('when GITHUB_REPO and GITHUB_TOKEN are set', () => {
    it('fetches repo metadata and returns a written result with the year of created_at', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ created_at: '2014-09-15T19:39:17Z' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )

      const result = await deriveRepoStartYear({
        fetchImpl: mockFetch as unknown as typeof fetch,
        env: { GITHUB_REPO: 'octocat/hello-world', GITHUB_TOKEN: 'ghp_test' },
        outputPath: tempOutput(),
        log: logSpy,
        warn: warnSpy,
        error: errorSpy,
      })

      expect(result.status).toBe('written')
      expect(result.year).toBe(2014)
      expect(mockFetch).toHaveBeenCalledTimes(1)
      const [url, init] = mockFetch.mock.calls[0]
      expect(url).toBe('https://api.github.com/repos/octocat/hello-world')
      const headers = (init as RequestInit).headers as Record<string, string>
      expect(headers['Authorization']).toBe('Bearer ghp_test')
      expect(headers['Accept']).toBe('application/vnd.github+json')
      expect(headers['X-GitHub-Api-Version']).toBe('2022-11-28')
      expect(headers['User-Agent']).toBe('solid-github-netlify')
    })

    it('writes a generated module exporting REPO_START_YEAR as the year of created_at', async () => {
      const out = tempOutput()
      const mockFetch = vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ created_at: '2014-09-15T19:39:17Z' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )

      const result = await deriveRepoStartYear({
        fetchImpl: mockFetch as unknown as typeof fetch,
        env: { GITHUB_REPO: 'octocat/hello-world', GITHUB_TOKEN: 'ghp_test' },
        outputPath: out,
        log: logSpy,
        warn: warnSpy,
        error: errorSpy,
      })

      expect(result.status).toBe('written')
      expect(existsSync(out)).toBe(true)
      const content = readFileSync(out, 'utf-8')
      expect(content).toMatch(/export const REPO_START_YEAR = 2014\b/)
    })

    it('logs the derived year and source repo', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ created_at: '2020-06-01T00:00:00Z' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )

      await deriveRepoStartYear({
        fetchImpl: mockFetch as unknown as typeof fetch,
        env: { GITHUB_REPO: 'octocat/hello-world', GITHUB_TOKEN: 'ghp_test' },
        outputPath: tempOutput(),
        log: logSpy,
        warn: warnSpy,
        error: errorSpy,
      })

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringMatching(/REPO_START_YEAR=2020/)
      )
      expect(logSpy.mock.calls[0][0]).toContain('octocat/hello-world')
    })
  })

  describe('when env vars are missing', () => {
    it('returns a skipped result without making an API call', async () => {
      const mockFetch = vi.fn()

      const result = await deriveRepoStartYear({
        fetchImpl: mockFetch as unknown as typeof fetch,
        env: { GITHUB_REPO: undefined, GITHUB_TOKEN: undefined },
        outputPath: tempOutput(),
        log: logSpy,
        warn: warnSpy,
        error: errorSpy,
      })

      expect(result.status).toBe('skipped')
      expect(result.reason).toBe('missing-env')
      expect(result.year).toBe(0)
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('warns to the warn channel and writes a placeholder file', async () => {
      const out = tempOutput()
      const mockFetch = vi.fn()

      await deriveRepoStartYear({
        fetchImpl: mockFetch as unknown as typeof fetch,
        env: { GITHUB_REPO: undefined, GITHUB_TOKEN: undefined },
        outputPath: out,
        log: logSpy,
        warn: warnSpy,
        error: errorSpy,
      })

      expect(warnSpy).toHaveBeenCalled()
      const message = warnSpy.mock.calls[0][0]
      expect(message).toMatch(/placeholder|skip|set GITHUB_REPO/i)
      expect(existsSync(out)).toBe(true)
      const content = readFileSync(out, 'utf-8')
      expect(content).toMatch(/export const REPO_START_YEAR = 0\b/)
    })
  })

  describe('when GITHUB_REPO is malformed', () => {
    it('returns a failed result with bad-repo-format reason', async () => {
      const mockFetch = vi.fn()

      const result = await deriveRepoStartYear({
        fetchImpl: mockFetch as unknown as typeof fetch,
        env: { GITHUB_REPO: 'no-slash-here', GITHUB_TOKEN: 'ghp_test' },
        outputPath: tempOutput(),
        log: logSpy,
        warn: warnSpy,
        error: errorSpy,
      })

      expect(result.status).toBe('failed')
      expect(result.reason).toBe('bad-repo-format')
      expect(mockFetch).not.toHaveBeenCalled()
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringMatching(/owner\/repo/)
      )
    })
  })

  describe('when the API returns a non-2xx response', () => {
    it('returns a failed result with the http status as reason', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce(
        new Response('Not Found', { status: 404 })
      )

      const result = await deriveRepoStartYear({
        fetchImpl: mockFetch as unknown as typeof fetch,
        env: { GITHUB_REPO: 'octocat/hello-world', GITHUB_TOKEN: 'ghp_test' },
        outputPath: tempOutput(),
        log: logSpy,
        warn: warnSpy,
        error: errorSpy,
      })

      expect(result.status).toBe('failed')
      expect(result.reason).toBe('http-404')
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringMatching(/404/)
      )
    })
  })

  describe('when the response is missing created_at', () => {
    it('returns a failed result with missing-created-at reason', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )

      const result = await deriveRepoStartYear({
        fetchImpl: mockFetch as unknown as typeof fetch,
        env: { GITHUB_REPO: 'octocat/hello-world', GITHUB_TOKEN: 'ghp_test' },
        outputPath: tempOutput(),
        log: logSpy,
        warn: warnSpy,
        error: errorSpy,
      })

      expect(result.status).toBe('failed')
      expect(result.reason).toBe('missing-created-at')
    })
  })

  describe('when the response has an unparseable created_at', () => {
    it('returns a failed result with bad-created-at reason', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ created_at: 'not-a-date' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )

      const result = await deriveRepoStartYear({
        fetchImpl: mockFetch as unknown as typeof fetch,
        env: { GITHUB_REPO: 'octocat/hello-world', GITHUB_TOKEN: 'ghp_test' },
        outputPath: tempOutput(),
        log: logSpy,
        warn: warnSpy,
        error: errorSpy,
      })

      expect(result.status).toBe('failed')
      expect(result.reason).toBe('bad-created-at')
    })
  })

  describe('when the generated file already exists', () => {
    it('overwrites it on a successful run', async () => {
      const out = tempOutput()
      mkdirSync(dirname(out), { recursive: true })
      writeFileSync(out, 'export const REPO_START_YEAR = 1900;\n')
      const mockFetch = vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ created_at: '2014-09-15T19:39:17Z' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )

      await deriveRepoStartYear({
        fetchImpl: mockFetch as unknown as typeof fetch,
        env: { GITHUB_REPO: 'octocat/hello-world', GITHUB_TOKEN: 'ghp_test' },
        outputPath: out,
        log: logSpy,
        warn: warnSpy,
        error: errorSpy,
      })

      const content = readFileSync(out, 'utf-8')
      expect(content).toMatch(/export const REPO_START_YEAR = 2014\b/)
    })
  })

  describe('default output path targets the router directory', () => {
    it('writes to netlify/functions/router/repo-start-year.generated.mjs when no outputPath is given', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ created_at: '2014-09-15T19:39:17Z' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )

      const result = await deriveRepoStartYear({
        fetchImpl: mockFetch as unknown as typeof fetch,
        env: { GITHUB_REPO: 'octocat/hello-world', GITHUB_TOKEN: 'ghp_test' },
        log: logSpy,
        warn: warnSpy,
        error: errorSpy,
      })

      expect(result.status).toBe('written')
      expect(result.path).toBe(GENERATED)
      expect(existsSync(GENERATED)).toBe(true)
      const content = readFileSync(GENERATED, 'utf-8')
      expect(content).toMatch(/export const REPO_START_YEAR = 2014\b/)
    })
  })
})
