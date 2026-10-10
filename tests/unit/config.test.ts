import { describe, it, expect, beforeEach, afterEach } from 'vitest'

describe('loadConfig', () => {
  const ORIGINAL_ENV = process.env

  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      GITHUB_REPO: 'octocat/hello-world',
      GITHUB_TOKEN: 'ghp_test'
    }
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

describe('loadConfig GitHub fields', () => {
  const ORIGINAL_ENV = process.env

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, WRITE_WEBIDS: 'https://alice.example/webid#me' }
  })

  afterEach(() => {
    process.env = ORIGINAL_ENV
  })

  it('throws when GITHUB_REPO is missing', async () => {
    delete process.env.GITHUB_REPO
    const { loadConfig } = await import('../../src/config.js')
    expect(() => loadConfig()).toThrow('GITHUB_REPO is required')
  })

  it('throws when GITHUB_REPO is empty', async () => {
    process.env.GITHUB_REPO = ''
    const { loadConfig } = await import('../../src/config.js')
    expect(() => loadConfig()).toThrow('GITHUB_REPO is required')
  })

  it('throws when GITHUB_REPO is not in owner/repo form', async () => {
    process.env.GITHUB_REPO = 'no-slash-here'
    const { loadConfig } = await import('../../src/config.js')
    expect(() => loadConfig()).toThrow('GITHUB_REPO must be in owner/repo form')
  })

  it('throws when GITHUB_TOKEN is missing', async () => {
    process.env.GITHUB_REPO = 'octocat/hello-world'
    delete process.env.GITHUB_TOKEN
    const { loadConfig } = await import('../../src/config.js')
    expect(() => loadConfig()).toThrow('GITHUB_TOKEN is required')
  })

  it('parses GITHUB_REPO and GITHUB_TOKEN and defaults GITHUB_REF to "HEAD"', async () => {
    process.env.GITHUB_REPO = 'octocat/hello-world'
    process.env.GITHUB_TOKEN = 'ghp_test'
    delete process.env.GITHUB_REF
    const { loadConfig } = await import('../../src/config.js')
    const config = loadConfig()
    expect(config.githubRepo).toBe('octocat/hello-world')
    expect(config.githubToken).toBe('ghp_test')
    expect(config.githubRef).toBe('HEAD')
  })

  it('uses GITHUB_REF when provided', async () => {
    process.env.GITHUB_REPO = 'octocat/hello-world'
    process.env.GITHUB_TOKEN = 'ghp_test'
    process.env.GITHUB_REF = 'main'
    const { loadConfig } = await import('../../src/config.js')
    const config = loadConfig()
    expect(config.githubRef).toBe('main')
  })
})

describe('loadAclConfig', () => {
  const ORIGINAL_ENV = process.env

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV }
    delete process.env.OWNER_WEBIDS
    delete process.env.ACL_STORE
    delete process.env.ACL_AUDIT_STORE
  })

  afterEach(() => {
    process.env = ORIGINAL_ENV
  })

  it('throws when OWNER_WEBIDS is missing', async () => {
    const { loadAclConfig } = await import('../../src/config.js')
    expect(() => loadAclConfig()).toThrow('OWNER_WEBIDS is required')
  })

  it('throws when OWNER_WEBIDS is empty', async () => {
    process.env.OWNER_WEBIDS = ''
    const { loadAclConfig } = await import('../../src/config.js')
    expect(() => loadAclConfig()).toThrow('OWNER_WEBIDS is required')
  })

  it('throws when OWNER_WEBIDS is only whitespace and commas', async () => {
    process.env.OWNER_WEBIDS = ' , , '
    const { loadAclConfig } = await import('../../src/config.js')
    expect(() => loadAclConfig()).toThrow('OWNER_WEBIDS is required')
  })

  it('parses a single owner webid', async () => {
    process.env.OWNER_WEBIDS = 'https://alice.example/webid#me'
    const { loadAclConfig } = await import('../../src/config.js')
    const config = loadAclConfig()
    expect(config.ownerWebIds).toEqual(['https://alice.example/webid#me'])
  })

  it('parses comma-separated owner webids and trims whitespace', async () => {
    process.env.OWNER_WEBIDS = ' https://alice.example/webid#me , https://bob.example/webid#me '
    const { loadAclConfig } = await import('../../src/config.js')
    const config = loadAclConfig()
    expect(config.ownerWebIds).toEqual([
      'https://alice.example/webid#me',
      'https://bob.example/webid#me'
    ])
  })

  it('drops empty entries between commas', async () => {
    process.env.OWNER_WEBIDS = 'https://alice.example/webid#me,,https://bob.example/webid#me,'
    const { loadAclConfig } = await import('../../src/config.js')
    const config = loadAclConfig()
    expect(config.ownerWebIds).toEqual([
      'https://alice.example/webid#me',
      'https://bob.example/webid#me'
    ])
  })

  it('defaults aclStore to "acl" and aclAuditStore to "acl-audit"', async () => {
    process.env.OWNER_WEBIDS = 'https://alice.example/webid#me'
    const { loadAclConfig } = await import('../../src/config.js')
    const config = loadAclConfig()
    expect(config.aclStore).toBe('acl')
    expect(config.aclAuditStore).toBe('acl-audit')
  })

  it('uses explicit ACL_STORE and ACL_AUDIT_STORE values', async () => {
    process.env.OWNER_WEBIDS = 'https://alice.example/webid#me'
    process.env.ACL_STORE = 'my-acl'
    process.env.ACL_AUDIT_STORE = 'my-acl-audit'
    const { loadAclConfig } = await import('../../src/config.js')
    const config = loadAclConfig()
    expect(config.aclStore).toBe('my-acl')
    expect(config.aclAuditStore).toBe('my-acl-audit')
  })

  it('falls back to defaults when ACL_STORE and ACL_AUDIT_STORE are empty strings', async () => {
    process.env.OWNER_WEBIDS = 'https://alice.example/webid#me'
    process.env.ACL_STORE = ''
    process.env.ACL_AUDIT_STORE = ''
    const { loadAclConfig } = await import('../../src/config.js')
    const config = loadAclConfig()
    expect(config.aclStore).toBe('acl')
    expect(config.aclAuditStore).toBe('acl-audit')
  })
})