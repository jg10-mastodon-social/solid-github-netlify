import { describe, it, expect, beforeEach, afterEach } from 'vitest'

describe('loadConfig', () => {
  const ORIGINAL_ENV = process.env

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV }
  })

  afterEach(() => {
    process.env = ORIGINAL_ENV
  })

  it('throws when WRITE_WEBIDS is missing', async () => {
    delete process.env.WRITE_WEBIDS
    const { loadConfig } = await import('../../src/config.js')
    expect(() => loadConfig()).toThrow('WRITE_WEBIDS is required')
  })

  it('throws when WRITE_WEBIDS is empty', async () => {
    process.env.WRITE_WEBIDS = ''
    const { loadConfig } = await import('../../src/config.js')
    expect(() => loadConfig()).toThrow('WRITE_WEBIDS is required')
  })

  it('throws when WRITE_WEBIDS is only whitespace and commas', async () => {
    process.env.WRITE_WEBIDS = ' , , '
    const { loadConfig } = await import('../../src/config.js')
    expect(() => loadConfig()).toThrow('WRITE_WEBIDS is required')
  })

  it('parses a single webid', async () => {
    process.env.WRITE_WEBIDS = 'https://alice.example/webid#me'
    const { loadConfig } = await import('../../src/config.js')
    const config = loadConfig()
    expect(config.writeWebIds).toEqual(['https://alice.example/webid#me'])
  })

  it('parses comma-separated webids and trims whitespace', async () => {
    process.env.WRITE_WEBIDS = ' https://alice.example/webid#me , https://bob.example/webid#me '
    const { loadConfig } = await import('../../src/config.js')
    const config = loadConfig()
    expect(config.writeWebIds).toEqual([
      'https://alice.example/webid#me',
      'https://bob.example/webid#me'
    ])
  })

  it('drops empty entries between commas', async () => {
    process.env.WRITE_WEBIDS = 'https://alice.example/webid#me,,https://bob.example/webid#me,'
    const { loadConfig } = await import('../../src/config.js')
    const config = loadConfig()
    expect(config.writeWebIds).toEqual([
      'https://alice.example/webid#me',
      'https://bob.example/webid#me'
    ])
  })
})