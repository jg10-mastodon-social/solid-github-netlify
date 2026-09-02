import { describe, it, expect } from 'vitest'
import { devServerUrl, getDevServerLogs } from '../helpers/dev-server.js'

async function fetchWithRetry(
  input: string | URL,
  init?: RequestInit,
  attempts = 3,
): Promise<Response> {
  let lastError: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetch(input, init)
    } catch (err) {
      lastError = err
      await new Promise(resolve => setTimeout(resolve, 250 * (i + 1)))
    }
  }
  throw lastError
}

describe('router function via netlify dev', () => {
  it('returns 204 for OPTIONS /foo/bar', async () => {
    const res = await fetchWithRetry(`${devServerUrl}/foo/bar`, {
      method: 'OPTIONS',
      headers: {
        'Access-Control-Request-Method': 'PUT',
        'Access-Control-Request-Headers': 'Authorization, Content-Type'
      }
    })

    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('PUT, GET, OPTIONS')
    expect(res.headers.get('Access-Control-Allow-Headers')).toBe(
      'Authorization, DPoP, Content-Type, Accept, Date, Digest, Signature, If-None-Match, If-Match'
    )
  })

  it('returns 204 for OPTIONS on the draft route', async () => {
    const res = await fetchWithRetry(`${devServerUrl}/foo/history/draft/bar`, {
      method: 'OPTIONS'
    })

    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('PUT, GET, OPTIONS')
  })

  it('returns 204 for OPTIONS on a 3-segment path', async () => {
    const res = await fetchWithRetry(`${devServerUrl}/foo/bar/baz`, {
      method: 'OPTIONS',
      headers: {
        'Access-Control-Request-Method': 'PUT',
        'Access-Control-Request-Headers': 'Authorization, Content-Type'
      }
    })

    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('PUT, GET, OPTIONS')
  })

  it('invokes the function for GET on a 3-segment path', async () => {
    const res = await fetchWithRetry(`${devServerUrl}/foo/bar/baz`, { method: 'GET' })

    // The function is invoked via the greedy /:page*/:doc match. With GITHUB_TOKEN=dummy
    // set in netlify.toml, fetchFileFromGitHub runs in offline mode and returns a
    // synthetic 404, which the router passes through.
    expect(res.status).toBe(404)
  })

  it('returns 401 for PUT on a nested draft path without Authorization header', async () => {
    const res = await fetchWithRetry(`${devServerUrl}/foo/bar/history/draft/baz`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ping: 'pong' })
    })

    expect(res.status).toBe(401)
    expect(await res.text()).toBe('Authorization required')
  })

  it('echoes Origin on OPTIONS when provided', async () => {
    const res = await fetchWithRetry(`${devServerUrl}/foo/bar`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://example.com' }
    })

    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://example.com')
    expect(res.headers.get('Vary')).toBe('Origin')
  })

  it('returns 404 for GET /foo/bar when offline mode is active', async () => {
    const res = await fetchWithRetry(`${devServerUrl}/foo/bar`, { method: 'GET' })

    // GITHUB_TOKEN=dummy is set in netlify.toml [context.dev.environment], so the
    // function proceeds past config load. fetchFileFromGitHub hits the offline
    // bypass (token === 'dummy') and returns a synthetic 404.
    expect(res.status).toBe(404)
  })
  it('returns 401 for PUT /foo/history/draft/bar without Authorization header', async () => {
    const res = await fetchWithRetry(`${devServerUrl}/foo/history/draft/bar`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ping: 'pong' })
    })

    expect(res.status).toBe(401)
    expect(await res.text()).toBe('Authorization required')
  })
  it('attaches CORS headers to GET responses', async () => {
    const res = await fetchWithRetry(`${devServerUrl}/foo/bar`, {
      method: 'GET',
      headers: { Origin: 'https://example.com' }
    })

    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://example.com')
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('PUT, GET, OPTIONS')
    expect(res.headers.get('Vary')).toBe('Origin')
  })

  it('advertises If-Match in the preflight Allow-Headers', async () => {
    const res = await fetchWithRetry(`${devServerUrl}/foo/bar`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://example.com',
        'Access-Control-Request-Method': 'PUT',
        'Access-Control-Request-Headers': 'If-Match'
      }
    })

    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('If-Match')
  })
})

describe('router route order (regression: greedy :page* must not swallow /history/draft/)', () => {
  it('routes /foo/history/draft/bar to path=foo/bar ref=foo-draft then falls back to ref=HEAD via netlify dev', async () => {
    const before = getDevServerLogs().length
    const res = await fetchWithRetry(`${devServerUrl}/foo/history/draft/bar`, { method: 'GET' })
    await new Promise(resolve => setTimeout(resolve, 200))
    const logs = getDevServerLogs().slice(before)
    expect(logs).toMatch(
      /\[github\] GET https:\/\/api\.github\.com\/repos\/octocat\/hello-world\/contents\/foo\/bar\?ref=foo-draft\b/
    )
    expect(logs).toMatch(
      /\[github\] GET https:\/\/api\.github\.com\/repos\/octocat\/hello-world\/contents\/foo\/bar\?ref=HEAD \(fallback\)/
    )
    expect(res.status).toBe(404)
    expect(res.headers.get('WAC-Allow')).toBe('user="read", public="read"')
  })

  it('routes /foo/bar to path=foo/bar ref=HEAD via netlify dev (no fallback fires)', async () => {
    const before = getDevServerLogs().length
    const res = await fetchWithRetry(`${devServerUrl}/foo/bar`, { method: 'GET' })
    await new Promise(resolve => setTimeout(resolve, 200))
    const logs = getDevServerLogs().slice(before)
    expect(logs).toMatch(
      /\[github\] GET https:\/\/api\.github\.com\/repos\/octocat\/hello-world\/contents\/foo\/bar\?ref=HEAD\b(?!\s*\(fallback\))/
    )
    expect(logs).not.toMatch(/\(fallback\)/)
    expect(res.status).toBe(404)
    expect(res.headers.get('WAC-Allow')).toBeNull()
  })
})
