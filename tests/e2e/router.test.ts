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
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('PATCH, PUT, GET, OPTIONS')
    expect(res.headers.get('Access-Control-Allow-Headers')).toBe(
      'Authorization, DPoP, Content-Type, Accept, Date, Digest, Signature, If-None-Match, If-Match'
    )
  })

  it('returns 204 for OPTIONS on the draft route', async () => {
    const res = await fetchWithRetry(`${devServerUrl}/foo/history/draft/bar`, {
      method: 'OPTIONS'
    })

    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('PATCH, PUT, GET, OPTIONS')
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
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('PATCH, PUT, GET, OPTIONS')
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
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('PATCH, PUT, GET, OPTIONS')
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

  it('routes /blog/04/history/draft/pantry.png to path=blog/04/pantry.png ref=blog/04-draft (regression: multi-segment :doc* must not be eaten by :page*)', async () => {
    const before = getDevServerLogs().length
    const res = await fetchWithRetry(`${devServerUrl}/blog/04/history/draft/pantry.png`, { method: 'GET' })
    await new Promise(resolve => setTimeout(resolve, 200))
    const logs = getDevServerLogs().slice(before)
    expect(logs).toMatch(
      /\[github\] GET https:\/\/api\.github\.com\/repos\/octocat\/hello-world\/contents\/blog\/04\/pantry\.png\?ref=blog(?:\/|%2F)04-draft\b/
    )
    expect(logs).toMatch(
      /\[github\] GET https:\/\/api\.github\.com\/repos\/octocat\/hello-world\/contents\/blog\/04\/pantry\.png\?ref=HEAD \(fallback\)/
    )
    expect(logs).not.toMatch(/ref=blog(?:\/|%2F)04(?:\/|%2F)history(?:\/|%2F)draft(?:\/|%2F)\d+-draft/)
    expect(res.status).toBe(404)
    expect(res.headers.get('WAC-Allow')).toBe('user="read", public="read"')
  })

  it('routes /blog/history/draft/03/pantry.png to path=blog/03/pantry.png ref=blog-draft (regression: nested page + multi-segment :doc*)', async () => {
    const before = getDevServerLogs().length
    const res = await fetchWithRetry(`${devServerUrl}/blog/history/draft/03/pantry.png`, { method: 'GET' })
    await new Promise(resolve => setTimeout(resolve, 200))
    const logs = getDevServerLogs().slice(before)
    expect(logs).toMatch(
      /\[github\] GET https:\/\/api\.github\.com\/repos\/octocat\/hello-world\/contents\/blog\/03\/pantry\.png\?ref=blog-draft\b/
    )
    expect(logs).toMatch(
      /\[github\] GET https:\/\/api\.github\.com\/repos\/octocat\/hello-world\/contents\/blog\/03\/pantry\.png\?ref=HEAD \(fallback\)/
    )
    expect(logs).not.toMatch(/ref=blog\/history\/draft\/\d+-draft/)
    expect(res.status).toBe(404)
    expect(res.headers.get('WAC-Allow')).toBe('user="read", public="read"')
  })
})

describe('router container listings via netlify dev', () => {
  it('returns 404 for GET / in offline mode (dummy token, path=empty)', async () => {
    const before = getDevServerLogs().length
    const res = await fetchWithRetry(`${devServerUrl}/`, { method: 'GET' })
    await new Promise(resolve => setTimeout(resolve, 200))
    const logs = getDevServerLogs().slice(before)
    expect(res.status).toBe(404)
    expect(res.headers.get('WAC-Allow')).toBeNull()
    expect(logs).toMatch(
      /\[github\] GET https:\/\/api\.github\.com\/repos\/octocat\/hello-world\/contents\/\?ref=HEAD\b/
    )
  })

  it('returns 204 for OPTIONS /foo/ CORS preflight', async () => {
    const res = await fetchWithRetry(`${devServerUrl}/foo/`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://example.com',
        'Access-Control-Request-Method': 'GET'
      }
    })
    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://example.com')
  })

  it('returns 404 for GET /foo/ in offline mode and queries path=foo ref=HEAD', async () => {
    const before = getDevServerLogs().length
    const res = await fetchWithRetry(`${devServerUrl}/foo/`, { method: 'GET' })
    await new Promise(resolve => setTimeout(resolve, 200))
    const logs = getDevServerLogs().slice(before)
    expect(res.status).toBe(404)
    expect(logs).toMatch(
      /\[github\] GET https:\/\/api\.github\.com\/repos\/octocat\/hello-world\/contents\/foo\?ref=HEAD\b/
    )
  })

  it('returns 404 for GET /foo/history/draft/ in offline mode, falling back to ref=HEAD', async () => {
    const before = getDevServerLogs().length
    const res = await fetchWithRetry(`${devServerUrl}/foo/history/draft/`, { method: 'GET' })
    await new Promise(resolve => setTimeout(resolve, 200))
    const logs = getDevServerLogs().slice(before)
    expect(res.status).toBe(404)
    expect(res.headers.get('WAC-Allow')).toBe('user="read", public="read"')
    expect(logs).toMatch(
      /\[github\] GET https:\/\/api\.github\.com\/repos\/octocat\/hello-world\/contents\/foo\?ref=foo-draft\b/
    )
    expect(logs).toMatch(
      /\[github\] GET https:\/\/api\.github\.com\/repos\/octocat\/hello-world\/contents\/foo\?ref=HEAD \(fallback\)/
    )
  })
})

describe('history routes via netlify dev (offline)', () => {
  it('GET /foo/history invokes the function and serves the year listing (200)', async () => {
    // The function being invoked (rather than 404 from Netlify routing miss)
    // is the routing smoke test. The history root makes no GitHub calls, so
    // it returns 200 with the year listing even in offline mode.
    const res = await fetchWithRetry(`${devServerUrl}/foo/history`, { method: 'GET' })
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toMatch(/ldp:BasicContainer/)
  })

  it('GET /foo/history/2026/ invokes the function and serves an empty year container (200)', async () => {
    const res = await fetchWithRetry(`${devServerUrl}/foo/history/2026/`, { method: 'GET' })
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).not.toMatch(/ldp:contains/)
    expect(body).toMatch(/<>\s+a\s+ldp:Container,\s+ldp:BasicContainer\s*\./)
  })

  it('GET /foo/history/2026/08/ invokes the function and serves an empty month container (200)', async () => {
    const res = await fetchWithRetry(`${devServerUrl}/foo/history/2026/08/`, { method: 'GET' })
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).not.toMatch(/ldp:contains/)
    expect(body).toMatch(/<>\s+a\s+ldp:Container,\s+ldp:BasicContainer\s*\./)
  })

  it('GET /foo/history/abc1234/ invokes the function and returns 404 (commit folder)', async () => {
    const res = await fetchWithRetry(`${devServerUrl}/foo/history/abc1234/`, { method: 'GET' })
    expect(res.status).toBe(404)
  })

  it('GET /foo/history/abc1234/foo.txt invokes the function and returns 404 (file)', async () => {
    const res = await fetchWithRetry(`${devServerUrl}/foo/history/abc1234/foo.txt`, { method: 'GET' })
    expect(res.status).toBe(404)
  })

  it('GET /foo/history/2024/03/abc1234/foo.txt (bucket-prefixed) invokes the function and returns 404', async () => {
    const res = await fetchWithRetry(
      `${devServerUrl}/foo/history/2024/03/abc1234/foo.txt`,
      { method: 'GET' }
    )
    expect(res.status).toBe(404)
  })

  it('GET /foo/history/draft (no doc) returns 404', async () => {
    const res = await fetchWithRetry(`${devServerUrl}/foo/history/draft`, { method: 'GET' })
    expect(res.status).toBe(404)
  })
})
