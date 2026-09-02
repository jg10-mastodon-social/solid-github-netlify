import { describe, it, expect } from 'vitest'
import { devServerUrl } from '../helpers/dev-server.js'

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
      'Authorization, DPoP, Content-Type, Accept, Date, Digest, Signature, If-None-Match'
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

    // Without the wildcard match the function is not invoked and Netlify returns 404.
    // The function being invoked without GITHUB_TOKEN configured fails with a 500
    // from the GitHub config loader.
    expect(res.status).toBe(500)
    expect(await res.text()).toContain('GITHUB_TOKEN is required')
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

  it('returns 500 for GET /foo/bar when GITHUB_TOKEN is not configured in netlify dev', async () => {
    const res = await fetchWithRetry(`${devServerUrl}/foo/bar`, { method: 'GET' })

    expect(res.status).toBe(500)
    expect(await res.text()).toContain('GITHUB_TOKEN is required')
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
})
