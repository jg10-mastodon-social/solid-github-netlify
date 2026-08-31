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
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Authorization, Content-Type'
      }
    })

    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('POST, GET, OPTIONS')
    expect(res.headers.get('Access-Control-Allow-Headers')).toBe(
      'Authorization, DPoP, Content-Type, Accept, Date, Digest, Signature'
    )
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

  it('returns "GET foo / bar" body for GET /foo/bar', async () => {
    const res = await fetchWithRetry(`${devServerUrl}/foo/bar`, { method: 'GET' })

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('GET foo / bar')
  })

  it('returns "POST api / events" body for POST /api/events', async () => {
    const res = await fetchWithRetry(`${devServerUrl}/api/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ping: 'pong' })
    })

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('POST api / events')
  })

  it('returns "POST a/b / c" for multi-segment page paths', async () => {
    const res = await fetchWithRetry(`${devServerUrl}/a/b/c`, { method: 'POST' })

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('POST a/b / c')
  })

  it('attaches CORS headers to GET responses', async () => {
    const res = await fetchWithRetry(`${devServerUrl}/foo/bar`, {
      method: 'GET',
      headers: { Origin: 'https://example.com' }
    })

    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://example.com')
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('POST, GET, OPTIONS')
    expect(res.headers.get('Vary')).toBe('Origin')
  })
})
