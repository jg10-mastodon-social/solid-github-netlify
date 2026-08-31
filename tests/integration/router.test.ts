import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Context } from '@netlify/functions'

function makeContext(overrides: Partial<Context> = {}): Context {
  return {
    requestId: 'test-request-id',
    server: { region: 'us-east-1' },
    waitUntil: vi.fn(),
    cookies: { get: vi.fn(), set: vi.fn(), delete: vi.fn() } as unknown as Context['cookies'],
    geo: {},
    ip: '127.0.0.1',
    site: {},
    deploy: { context: 'dev', id: 'test', published: false },
    account: { id: 'test' },
    json: vi.fn(),
    log: vi.fn(),
    next: vi.fn(),
    params: { page: 'foo', doc: 'bar' },
    rewrite: vi.fn(),
    ...overrides,
  } as unknown as Context
}

describe('router OPTIONS preflight', () => {
  it('returns 204 with default CORS headers when no Origin is provided', async () => {
    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/bar', { method: 'OPTIONS' })
    const res = await handler(req, makeContext())

    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('POST, GET, OPTIONS')
    expect(res.headers.get('Access-Control-Allow-Headers')).toBe(
      'Authorization, DPoP, Content-Type, Accept, Date, Digest, Signature'
    )
    expect(res.headers.get('Vary')).toBe('Origin')
  })

  it('echoes the Origin header when one is provided', async () => {
    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/bar', {
      method: 'OPTIONS',
      headers: { Origin: 'https://example.com' }
    })
    const res = await handler(req, makeContext())

    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://example.com')
    expect(res.headers.get('Vary')).toBe('Origin')
  })

  it('returns an empty body for OPTIONS', async () => {
    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/bar', { method: 'OPTIONS' })
    const res = await handler(req, makeContext())

    expect(await res.text()).toBe('')
  })
})

describe('router request handling', () => {
  it('returns `${method} ${page} / ${doc}` for GET /foo/bar', async () => {
    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/bar', { method: 'GET' })
    const res = await handler(req, makeContext({ params: { page: 'foo', doc: 'bar' } }))

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('GET foo / bar')
  })

  it('handles POST requests and reports the method in the body', async () => {
    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hello: 'world' })
    })
    const res = await handler(req, makeContext({ params: { page: 'api', doc: 'events' } }))

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('POST api / events')
  })

  it('joins page segments with slashes for multi-segment paths', async () => {
    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/a/b/c', { method: 'POST' })
    const res = await handler(req, makeContext({ params: { page: 'a/b', doc: 'c' } }))

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('POST a/b / c')
  })

  it('attaches CORS headers to non-OPTIONS responses', async () => {
    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/bar', {
      method: 'GET',
      headers: { Origin: 'https://example.com' }
    })
    const res = await handler(req, makeContext())

    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://example.com')
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('POST, GET, OPTIONS')
    expect(res.headers.get('Access-Control-Allow-Headers')).toBe(
      'Authorization, DPoP, Content-Type, Accept, Date, Digest, Signature'
    )
    expect(res.headers.get('Vary')).toBe('Origin')
  })
})

describe('router error handling', () => {
  it('returns 500 with the error message and still sets CORS headers', async () => {
    const { default: handler } = await import('../../netlify/functions/router/router.mts')
    const req = new Request('http://localhost/foo/bar', {
      method: 'GET',
      headers: { Origin: 'https://example.com' }
    })
    const boom = new Error('boom')
    const ctx = makeContext()
    Object.defineProperty(ctx, 'params', {
      get() {
        throw boom
      },
      configurable: true
    })

    const res = await handler(req, ctx)

    expect(res.status).toBe(500)
    expect(await res.text()).toContain('boom')
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://example.com')
    expect(res.headers.get('Vary')).toBe('Origin')
  })

  it('logs the method and pathname before handling the request', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const { default: handler } = await import('../../netlify/functions/router/router.mts')
      const req = new Request('http://localhost/foo/bar', { method: 'GET' })
      const ctx = makeContext()

      await handler(req, ctx)

      expect(logSpy).toHaveBeenCalled()
      const messages = logSpy.mock.calls.map(args => args.map(String).join(' '))
      expect(messages.some(m => m.includes('[router] GET') && m.includes('/foo/bar'))).toBe(true)
    } finally {
      logSpy.mockRestore()
    }
  })
})
