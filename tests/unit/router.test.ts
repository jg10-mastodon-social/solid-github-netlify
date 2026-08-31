import { describe, it, expect, vi } from 'vitest'

vi.mock('../../src/auth.js', () => ({
  verifyDpopToken: vi.fn()
}))

vi.mock('../../src/config.js', () => ({
  loadConfig: () => ({ writeWebIds: [] })
}))

describe('router config', () => {
  it('declares path /:page*/:doc', async () => {
    const { config } = await import('../../netlify/functions/router/router.mts')
    expect(config.path).toEqual(['/:page*/:doc'])
  })

  it('accepts PUT, GET and OPTIONS methods', async () => {
    const { config } = await import('../../netlify/functions/router/router.mts')
    expect(config.method).toEqual(expect.arrayContaining(['PUT', 'GET', 'OPTIONS']))
    expect(config.method).toHaveLength(3)
  })

  it('sets preferStatic to true so static assets win', async () => {
    const { config } = await import('../../netlify/functions/router/router.mts')
    expect(config.preferStatic).toBe(true)
  })
})