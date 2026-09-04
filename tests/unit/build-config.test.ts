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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function publicNotFound(): Response {
  return new Response(
    JSON.stringify({ message: 'Not Found' }),
    {
      status: 404,
      headers: { 'content-type': 'application/json' },
    }
  )
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

  describe('when REPO_START_YEAR is set', () => {
    it('uses the user-supplied year without making an API call', async () => {
      const mockFetch = vi.fn()
      const out = tempOutput()

      const result = await deriveRepoStartYear({
        fetchImpl: mockFetch as unknown as typeof fetch,
        env: { REPO_START_YEAR: '2019' },
        outputPath: out,
        log: logSpy,
        warn: warnSpy,
        error: errorSpy,
      })

      expect(result.status).toBe('written')
      expect(result.year).toBe(2019)
      expect(result.source).toBe('user')
      expect(mockFetch).not.toHaveBeenCalled()
      const content = readFileSync(out, 'utf-8')
      expect(content).toMatch(/export const REPO_START_YEAR = 2019\b/)
      expect(content).toMatch(/user-supplied/)
    })

    it('logs the user-supplied year and source', async () => {
      await deriveRepoStartYear({
        fetchImpl: vi.fn() as unknown as typeof fetch,
        env: { REPO_START_YEAR: '2019' },
        outputPath: tempOutput(),
        log: logSpy,
        warn: warnSpy,
        error: errorSpy,
      })

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringMatching(/REPO_START_YEAR=2019.*user env/)
      )
    })

    it('takes precedence over GITHUB_REPO and any successful public resolution', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce(
        jsonResponse({ created_at: '2014-09-15T19:39:17Z' })
      )

      const result = await deriveRepoStartYear({
        fetchImpl: mockFetch as unknown as typeof fetch,
        env: {
          REPO_START_YEAR: '2019',
          GITHUB_REPO: 'octocat/hello-world',
          GITHUB_TOKEN: 'ghp_test',
        },
        outputPath: tempOutput(),
        log: logSpy,
        warn: warnSpy,
        error: errorSpy,
      })

      expect(result.status).toBe('written')
      expect(result.year).toBe(2019)
      expect(result.source).toBe('user')
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('treats an empty string as not set and falls through', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce(
        jsonResponse({ created_at: '2014-09-15T19:39:17Z' })
      )

      const result = await deriveRepoStartYear({
        fetchImpl: mockFetch as unknown as typeof fetch,
        env: { REPO_START_YEAR: '', GITHUB_REPO: 'octocat/hello-world' },
        outputPath: tempOutput(),
        log: logSpy,
        warn: warnSpy,
        error: errorSpy,
      })

      expect(result.status).toBe('written')
      expect(result.source).toBe('public')
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it('fails with bad-user-year when the value is not a number', async () => {
      const mockFetch = vi.fn()

      const result = await deriveRepoStartYear({
        fetchImpl: mockFetch as unknown as typeof fetch,
        env: { REPO_START_YEAR: 'twentytwenty' },
        outputPath: tempOutput(),
        log: logSpy,
        warn: warnSpy,
        error: errorSpy,
      })

      expect(result.status).toBe('failed')
      expect(result.reason).toBe('bad-user-year')
      expect(mockFetch).not.toHaveBeenCalled()
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringMatching(/REPO_START_YEAR.*1900.*2100/)
      )
    })

    it('fails with bad-user-year when the value is out of range', async () => {
      for (const bad of ['1850', '2200', '99', '10000']) {
        errorSpy.mockClear()
        const result = await deriveRepoStartYear({
          fetchImpl: vi.fn() as unknown as typeof fetch,
          env: { REPO_START_YEAR: bad },
          outputPath: tempOutput(),
          log: logSpy,
          warn: warnSpy,
          error: errorSpy,
        })
        expect(result.status).toBe('failed')
        expect(result.reason).toBe('bad-user-year')
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringMatching(/1900.*2100/)
        )
      }
    })
  })

  describe('public resolution (no Authorization header)', () => {
    it('succeeds when the API returns a valid created_at without auth', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce(
        jsonResponse({ created_at: '2014-09-15T19:39:17Z' })
      )

      const result = await deriveRepoStartYear({
        fetchImpl: mockFetch as unknown as typeof fetch,
        env: { GITHUB_REPO: 'octocat/hello-world' },
        outputPath: tempOutput(),
        log: logSpy,
        warn: warnSpy,
        error: errorSpy,
      })

      expect(result.status).toBe('written')
      expect(result.year).toBe(2014)
      expect(result.source).toBe('public')
      const [url, init] = mockFetch.mock.calls[0]
      expect(url).toBe('https://api.github.com/repos/octocat/hello-world')
      const headers = (init as RequestInit).headers as Record<string, string>
      expect(headers['Authorization']).toBeUndefined()
      expect(headers['Accept']).toBe('application/vnd.github+json')
      expect(headers['X-GitHub-Api-Version']).toBe('2022-11-28')
      expect(headers['User-Agent']).toBe('solid-github-netlify')
    })

    it('writes the generated module from public resolution', async () => {
      const out = tempOutput()
      const mockFetch = vi.fn().mockResolvedValueOnce(
        jsonResponse({ created_at: '2014-09-15T19:39:17Z' })
      )

      await deriveRepoStartYear({
        fetchImpl: mockFetch as unknown as typeof fetch,
        env: { GITHUB_REPO: 'octocat/hello-world' },
        outputPath: out,
        log: logSpy,
        warn: warnSpy,
        error: errorSpy,
      })

      const content = readFileSync(out, 'utf-8')
      expect(content).toMatch(/export const REPO_START_YEAR = 2014\b/)
      expect(content).toMatch(/public GitHub API/)
    })

    it('ignores GITHUB_TOKEN on the public path', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce(
        jsonResponse({ created_at: '2020-06-01T00:00:00Z' })
      )

      const result = await deriveRepoStartYear({
        fetchImpl: mockFetch as unknown as typeof fetch,
        env: {
          GITHUB_REPO: 'octocat/hello-world',
          GITHUB_TOKEN: 'ghp_test',
        },
        outputPath: tempOutput(),
        log: logSpy,
        warn: warnSpy,
        error: errorSpy,
      })

      expect(result.status).toBe('written')
      expect(result.source).toBe('public')
      const [, init] = mockFetch.mock.calls[0]
      const headers = (init as RequestInit).headers as Record<string, string>
      expect(headers['Authorization']).toBeUndefined()
    })
  })

  describe('when public resolution fails and the token is masked', () => {
    it('fails with masked-token reason and instructs to set REPO_START_YEAR', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce(publicNotFound())

      const result = await deriveRepoStartYear({
        fetchImpl: mockFetch as unknown as typeof fetch,
        env: {
          GITHUB_REPO: 'octocat/hello-world',
          GITHUB_TOKEN: '****masked****',
        },
        outputPath: tempOutput(),
        log: logSpy,
        warn: warnSpy,
        error: errorSpy,
      })

      expect(result.status).toBe('failed')
      expect(result.reason).toBe('masked-token')
      expect(mockFetch).toHaveBeenCalledTimes(1)
      const message = errorSpy.mock.calls[0][0]
      expect(message).toMatch(/masked placeholder/i)
      expect(message).toMatch(/Set REPO_START_YEAR=<year>/)
      expect(message).toMatch(/netlify env:set GITHUB_TOKEN/)
    })

    it('detects a pure-asterisk token', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce(publicNotFound())

      const result = await deriveRepoStartYear({
        fetchImpl: mockFetch as unknown as typeof fetch,
        env: {
          GITHUB_REPO: 'octocat/hello-world',
          GITHUB_TOKEN: '****************',
        },
        outputPath: tempOutput(),
        log: logSpy,
        warn: warnSpy,
        error: errorSpy,
      })

      expect(result.status).toBe('failed')
      expect(result.reason).toBe('masked-token')
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it('does not attempt an authenticated retry when masked', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(publicNotFound())
        .mockResolvedValueOnce(
          jsonResponse({ created_at: '2014-09-15T19:39:17Z' })
        )

      const result = await deriveRepoStartYear({
        fetchImpl: mockFetch as unknown as typeof fetch,
        env: {
          GITHUB_REPO: 'octocat/hello-world',
          GITHUB_TOKEN: '****masked****',
        },
        outputPath: tempOutput(),
        log: logSpy,
        warn: warnSpy,
        error: errorSpy,
      })

      expect(result.status).toBe('failed')
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })
  })

  describe('when public resolution fails and no token is set', () => {
    it('writes a placeholder and warns with the REPO_START_YEAR escape hatch', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce(publicNotFound())
      const out = tempOutput()

      const result = await deriveRepoStartYear({
        fetchImpl: mockFetch as unknown as typeof fetch,
        env: { GITHUB_REPO: 'octocat/hello-world' },
        outputPath: out,
        log: logSpy,
        warn: warnSpy,
        error: errorSpy,
      })

      expect(result.status).toBe('skipped')
      expect(result.reason).toBe('public-failed-no-token')
      expect(result.year).toBe(0)
      expect(result.source).toBe('placeholder')
      const message = warnSpy.mock.calls[0][0]
      expect(message).toMatch(/Public resolution.*failed/)
      expect(message).toMatch(/Set REPO_START_YEAR=<year>/)
      const content = readFileSync(out, 'utf-8')
      expect(content).toMatch(/export const REPO_START_YEAR = 0\b/)
    })
  })

  describe('when public resolution fails and a real token is set', () => {
    it('falls back to an authenticated call and returns source auth', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(publicNotFound())
        .mockResolvedValueOnce(
          jsonResponse({ created_at: '2014-09-15T19:39:17Z' })
        )

      const result = await deriveRepoStartYear({
        fetchImpl: mockFetch as unknown as typeof fetch,
        env: {
          GITHUB_REPO: 'octocat/hello-world',
          GITHUB_TOKEN: 'ghp_real',
        },
        outputPath: tempOutput(),
        log: logSpy,
        warn: warnSpy,
        error: errorSpy,
      })

      expect(result.status).toBe('written')
      expect(result.year).toBe(2014)
      expect(result.source).toBe('auth')
      expect(mockFetch).toHaveBeenCalledTimes(2)
      const [, authInit] = mockFetch.mock.calls[1]
      const authHeaders = (authInit as RequestInit).headers as Record<string, string>
      expect(authHeaders['Authorization']).toBe('Bearer ghp_real')
    })
  })

  describe('authenticated fallback: non-2xx responses', () => {
    it('logs a JSON message and returns http-401 on a Bad credentials reply', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(publicNotFound())
        .mockResolvedValueOnce(
          jsonResponse(
            {
              message: 'Bad credentials',
              documentation_url: 'https://docs.github.com/...',
            },
            401
          )
        )

      const result = await deriveRepoStartYear({
        fetchImpl: mockFetch as unknown as typeof fetch,
        env: {
          GITHUB_REPO: 'octocat/hello-world',
          GITHUB_TOKEN: 'ghp_real',
        },
        outputPath: tempOutput(),
        log: logSpy,
        warn: warnSpy,
        error: errorSpy,
      })

      expect(result.status).toBe('failed')
      expect(result.reason).toBe('http-401')
      const message = errorSpy.mock.calls[0][0]
      expect(message).toMatch(/401/)
      expect(message).toMatch(/octocat\/hello-world/)
      expect(message).toMatch(/Bad credentials/)
    })

    it('falls back to the raw text body when the response is not JSON', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(publicNotFound())
        .mockResolvedValueOnce(new Response('Not Found', { status: 404 }))

      const result = await deriveRepoStartYear({
        fetchImpl: mockFetch as unknown as typeof fetch,
        env: {
          GITHUB_REPO: 'octocat/hello-world',
          GITHUB_TOKEN: 'ghp_real',
        },
        outputPath: tempOutput(),
        log: logSpy,
        warn: warnSpy,
        error: errorSpy,
      })

      expect(result.status).toBe('failed')
      expect(result.reason).toBe('http-404')
      const message = errorSpy.mock.calls[0][0]
      expect(message).toMatch(/404/)
      expect(message).toMatch(/Not Found/)
    })

    it('handles an empty error body without leaking undefined or null', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(publicNotFound())
        .mockResolvedValueOnce(new Response('', { status: 500 }))

      const result = await deriveRepoStartYear({
        fetchImpl: mockFetch as unknown as typeof fetch,
        env: {
          GITHUB_REPO: 'octocat/hello-world',
          GITHUB_TOKEN: 'ghp_real',
        },
        outputPath: tempOutput(),
        log: logSpy,
        warn: warnSpy,
        error: errorSpy,
      })

      expect(result.status).toBe('failed')
      expect(result.reason).toBe('http-500')
      const message = errorSpy.mock.calls[0][0]
      expect(message).toMatch(/500/)
      expect(message).toMatch(/octocat\/hello-world/)
      expect(message).not.toMatch(/undefined|null/)
    })
  })

  describe('authenticated fallback: malformed responses', () => {
    it('returns missing-created-at when the body has no created_at', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(publicNotFound())
        .mockResolvedValueOnce(jsonResponse({}))

      const result = await deriveRepoStartYear({
        fetchImpl: mockFetch as unknown as typeof fetch,
        env: {
          GITHUB_REPO: 'octocat/hello-world',
          GITHUB_TOKEN: 'ghp_real',
        },
        outputPath: tempOutput(),
        log: logSpy,
        warn: warnSpy,
        error: errorSpy,
      })

      expect(result.status).toBe('failed')
      expect(result.reason).toBe('missing-created-at')
    })

    it('returns bad-created-at when created_at is unparseable', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(publicNotFound())
        .mockResolvedValueOnce(jsonResponse({ created_at: 'not-a-date' }))

      const result = await deriveRepoStartYear({
        fetchImpl: mockFetch as unknown as typeof fetch,
        env: {
          GITHUB_REPO: 'octocat/hello-world',
          GITHUB_TOKEN: 'ghp_real',
        },
        outputPath: tempOutput(),
        log: logSpy,
        warn: warnSpy,
        error: errorSpy,
      })

      expect(result.status).toBe('failed')
      expect(result.reason).toBe('bad-created-at')
    })
  })

  describe('when GITHUB_REPO is malformed', () => {
    it('returns a failed result with bad-repo-format reason', async () => {
      const mockFetch = vi.fn()

      const result = await deriveRepoStartYear({
        fetchImpl: mockFetch as unknown as typeof fetch,
        env: { GITHUB_REPO: 'no-slash-here', GITHUB_TOKEN: 'ghp_real' },
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

  describe('when neither REPO_START_YEAR nor GITHUB_REPO is set', () => {
    it('returns a skipped result without making an API call', async () => {
      const mockFetch = vi.fn()

      const result = await deriveRepoStartYear({
        fetchImpl: mockFetch as unknown as typeof fetch,
        env: {
          REPO_START_YEAR: undefined,
          GITHUB_REPO: undefined,
          GITHUB_TOKEN: undefined,
        },
        outputPath: tempOutput(),
        log: logSpy,
        warn: warnSpy,
        error: errorSpy,
      })

      expect(result.status).toBe('skipped')
      expect(result.reason).toBe('missing-repo')
      expect(result.year).toBe(0)
      expect(result.source).toBe('placeholder')
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('warns to the warn channel and writes a placeholder file', async () => {
      const out = tempOutput()
      const mockFetch = vi.fn()

      await deriveRepoStartYear({
        fetchImpl: mockFetch as unknown as typeof fetch,
        env: {
          REPO_START_YEAR: undefined,
          GITHUB_REPO: undefined,
          GITHUB_TOKEN: undefined,
        },
        outputPath: out,
        log: logSpy,
        warn: warnSpy,
        error: errorSpy,
      })

      expect(warnSpy).toHaveBeenCalled()
      const message = warnSpy.mock.calls[0][0]
      expect(message).toMatch(/REPO_START_YEAR/)
      expect(message).toMatch(/GITHUB_REPO/)
      expect(message).toMatch(/placeholder/i)
      expect(existsSync(out)).toBe(true)
      const content = readFileSync(out, 'utf-8')
      expect(content).toMatch(/export const REPO_START_YEAR = 0\b/)
    })
  })

  describe('when the generated file already exists', () => {
    it('overwrites it on a successful public resolution', async () => {
      const out = tempOutput()
      mkdirSync(dirname(out), { recursive: true })
      writeFileSync(out, 'export const REPO_START_YEAR = 1900;\n')
      const mockFetch = vi.fn().mockResolvedValueOnce(
        jsonResponse({ created_at: '2014-09-15T19:39:17Z' })
      )

      await deriveRepoStartYear({
        fetchImpl: mockFetch as unknown as typeof fetch,
        env: { GITHUB_REPO: 'octocat/hello-world' },
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
        jsonResponse({ created_at: '2014-09-15T19:39:17Z' })
      )

      const result = await deriveRepoStartYear({
        fetchImpl: mockFetch as unknown as typeof fetch,
        env: { GITHUB_REPO: 'octocat/hello-world' },
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