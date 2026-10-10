import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { PolicyDoc } from '../../../src/wac/policy.js'

interface Entry {
  data: unknown
  etag: string
  metadata: Record<string, unknown> | null
}

class MemoryBlobStore {
  entries = new Map<string, Entry>()
  setCallCount = 0
  private counter = 0

  private nextEtag(): string {
    this.counter += 1
    return `etag-${this.counter}`
  }

  async getWithMetadata(key: string, _options: { type: 'json' }): Promise<unknown> {
    const entry = this.entries.get(key)
    if (entry === undefined) return null
    return { data: entry.data, etag: entry.etag, metadata: entry.metadata }
  }

  async setJSON(
    key: string,
    value: unknown,
    options?: { metadata?: Record<string, unknown>; onlyIfNew?: boolean; onlyIfMatch?: string }
  ): Promise<{ modified: boolean }> {
    this.setCallCount += 1
    const existing = this.entries.get(key)
    if (options?.onlyIfNew === true && existing !== undefined) return { modified: false }
    if (
      options?.onlyIfMatch !== undefined &&
      (existing === undefined || existing.etag !== options.onlyIfMatch)
    ) {
      return { modified: false }
    }
    this.entries.set(key, {
      data: value,
      etag: this.nextEtag(),
      metadata: options?.metadata ?? null
    })
    return { modified: true }
  }

  async list(options?: {
    prefix?: string
  }): Promise<{ blobs: Array<{ key: string; etag: string; metadata: Entry['metadata'] }> }> {
    const prefix = options?.prefix
    return {
      blobs: [...this.entries.entries()]
        .filter(([key]) => prefix === undefined || key.startsWith(prefix))
        .map(([key, entry]) => ({ key, etag: entry.etag, metadata: entry.metadata }))
    }
  }
}

const hoisted = vi.hoisted(() => {
  const stores = new Map<string, MemoryBlobStore>()

  function getStore(options: { name: string }): MemoryBlobStore {
    let store = stores.get(options.name)
    if (store === undefined) {
      store = new MemoryBlobStore()
      stores.set(options.name, store)
    }
    return store
  }

  function reset(): void {
    stores.clear()
  }

  return { getStore, reset }
})

vi.mock('@netlify/blobs', () => ({
  getStore: (options: unknown) => hoisted.getStore(options as { name: string })
}))

import { loadEffectivePolicy, authorizeRequest, wacAllowRequest } from '../../../src/wac/runtime.js'

const owner = 'https://owner.example/profile#me'
const stranger = 'https://stranger.example/profile#me'

const ORIGINAL_ENV = process.env

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV, OWNER_WEBIDS: owner }
  delete process.env.ACL_STORE
  delete process.env.ACL_AUDIT_STORE
  hoisted.reset()
})

afterEach(() => {
  process.env = ORIGINAL_ENV
})

describe('loadEffectivePolicy', () => {
  it('bootstraps an empty store and returns a doc with a root scope', async () => {
    const doc = await loadEffectivePolicy()

    expect(doc.scopes['']).toEqual({ self: 'rs_root_self', default: 'rs_root_default' })
    expect(doc.updatedBy).toBe('system')

    const store = hoisted.getStore({ name: 'acl' })
    expect(store.entries.has('policy')).toBe(true)
    expect(store.setCallCount).toBe(1)
  })

  it('returns the existing doc without re-bootstrapping', async () => {
    const existing: PolicyDoc = {
      schema: 1,
      rev: 7,
      updatedAt: '2026-01-01T00:00:00.000Z',
      updatedBy: 'seed',
      scopes: { '': { self: 'rs_root_self', default: 'rs_root_default' } },
      rulesets: { rs_root_self: [], rs_root_default: [] }
    }
    const store = hoisted.getStore({ name: 'acl' })
    store.entries.set('policy', { data: existing, etag: 'etag-seed', metadata: null })

    const doc = await loadEffectivePolicy()

    expect(doc).toEqual(existing)
    expect(store.setCallCount).toBe(0)
  })
})

describe('authorizeRequest', () => {
  it('allows an owner WebID to write and denies an anonymous request', async () => {
    const allowed = await authorizeRequest({
      webId: owner,
      method: 'PUT',
      path: '/notes.ttl',
      exists: true
    })
    expect(allowed.allowed).toBe(true)

    const denied = await authorizeRequest({ method: 'PUT', path: '/notes.ttl', exists: true })
    expect(denied.allowed).toBe(false)
  })

  it('allows an owner on an .acl resource via the owner override', async () => {
    const result = await authorizeRequest({
      webId: owner,
      method: 'PUT',
      path: '/notes.ttl.acl',
      isAcl: true
    })
    expect(result.allowed).toBe(true)
    expect(result.ownerOverride).toBe(true)
  })

  it('denies a non-owner WebID with no matching grant', async () => {
    const result = await authorizeRequest({
      webId: stranger,
      method: 'GET',
      path: '/notes.ttl'
    })
    expect(result.allowed).toBe(false)
    expect(result.ownerOverride).toBe(false)
  })
})

describe('wacAllowRequest', () => {
  it('grants the owner read/write/control on the bootstrapped root scope with no public modes', async () => {
    const result = await wacAllowRequest({ webId: owner, path: '/' })

    expect(result.user).toEqual(['control', 'read', 'write'])
    expect(result.public).toEqual([])
  })

  it('reports user equal to public for an anonymous caller', async () => {
    const result = await wacAllowRequest({ path: '/' })

    expect(result.public).toEqual([])
    expect(result.user).toEqual(result.public)
  })
})
