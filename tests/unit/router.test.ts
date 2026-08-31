import { describe, it, expect } from 'vitest'

describe('router config', () => {
  it('declares path /:page*/:doc', async () => {
    const { config } = await import('../../netlify/functions/router/router.mts')
    expect(config.path).toEqual(['/:page*/:doc'])
  })

  it('accepts POST, GET and OPTIONS methods', async () => {
    const { config } = await import('../../netlify/functions/router/router.mts')
    expect(config.method).toEqual(expect.arrayContaining(['POST', 'GET', 'OPTIONS']))
    expect(config.method).toHaveLength(3)
  })

  it('sets preferStatic to true so static assets win', async () => {
    const { config } = await import('../../netlify/functions/router/router.mts')
    expect(config.preferStatic).toBe(true)
  })
})
