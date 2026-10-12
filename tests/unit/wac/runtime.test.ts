import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { PolicyDoc } from '../../../src/wac/policy.js'
import type { AuditEvent } from '../../../src/wac/audit.js'
import type { Rule } from '../../../src/wac/evaluate.js'

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

import {
  loadEffectivePolicy,
  authorizeRequest,
  wacAllowRequest,
  loadAcl,
  saveAcl,
  listAclAudit
} from '../../../src/wac/runtime.js'
import { rulesetId } from '../../../src/wac/policy.js'
import { appendEvent } from '../../../src/wac/audit.js'
import { openJsonStore } from '../../../src/wac/blobs.js'

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

  it('allows a non-owner WebID to read via the public rule but denies a write', async () => {
    const read = await authorizeRequest({
      webId: stranger,
      method: 'GET',
      path: '/notes.ttl'
    })
    expect(read.allowed).toBe(true)
    expect(read.ownerOverride).toBe(false)

    const write = await authorizeRequest({
      webId: stranger,
      method: 'PUT',
      path: '/notes.ttl',
      exists: true
    })
    expect(write.allowed).toBe(false)
    expect(write.ownerOverride).toBe(false)
  })
})

describe('wacAllowRequest', () => {
  it('grants the owner read/write/control and everyone public read on the bootstrapped root scope', async () => {
    const result = await wacAllowRequest({ webId: owner, path: '/' })

    expect(result.user).toEqual(['control', 'read', 'write'])
    expect(result.public).toEqual(['read'])
  })

  it('reports public read and user equal to public for an anonymous caller', async () => {
    const result = await wacAllowRequest({ path: '/' })

    expect(result.public).toEqual(['read'])
    expect(result.user).toEqual(result.public)
  })
})

const resourceUri = 'https://pod.example/foo/'

describe('loadAcl', () => {
  it('returns authored false and empty rules when no explicit scope entry exists', async () => {
    const view = await loadAcl({ path: '/foo/', resourceUri })

    expect(view).toEqual({
      scopeKey: '/foo/',
      resourceUri,
      rules: [],
      authored: false
    })
  })
})

describe('saveAcl', () => {
  it('persists rules and reports them as authored on reload', async () => {
    await loadEffectivePolicy()
    const rules: Rule[] = [{ subject: { class: 'public' }, modes: ['read'] }]

    await saveAcl({ path: '/foo/', actor: owner, rules })

    const view = await loadAcl({ path: '/foo/', resourceUri })
    expect(view.authored).toBe(true)
    expect(view.rules).toEqual(rules)
  })

  it('appends exactly one audit event with matching scope, actor and ruleset id', async () => {
    await loadEffectivePolicy()
    const rules: Rule[] = [{ subject: { class: 'public' }, modes: ['read'] }]

    await saveAcl({ path: '/foo/', actor: owner, rules })

    const auditStore = hoisted.getStore({ name: 'acl-audit' })
    const events = [...auditStore.entries.entries()]
      .filter(([key]) => key.startsWith('events/'))
      .map(([, entry]) => entry.data as AuditEvent)

    expect(events).toHaveLength(1)
    expect(events[0].scope).toBe('/foo/')
    expect(events[0].actor).toBe(owner)
    expect(events[0].after).toBe(rulesetId(rules))
  })

  it('lists appended audit events from the default acl-audit store', async () => {
    const store = openJsonStore('acl-audit')
    await appendEvent(store, {
      ts: '2026-01-01T00:00:00.000Z',
      actor: owner,
      scope: '/foo/',
      op: 'grant'
    })

    const events = await listAclAudit()

    expect(events).toHaveLength(1)
    expect(events[0].scope).toBe('/foo/')
    expect(events[0].actor).toBe(owner)

    const defaultStore = hoisted.getStore({ name: 'acl-audit' })
    const keys = [...defaultStore.entries.keys()].filter((key) => key.startsWith('events/'))
    expect(keys).toHaveLength(1)
  })

  it('honours ACL_STORE and ACL_AUDIT_STORE env overrides', async () => {
    process.env.ACL_STORE = 'custom-acl'
    process.env.ACL_AUDIT_STORE = 'custom-audit'
    await loadEffectivePolicy()
    const rules: Rule[] = [{ subject: { class: 'public' }, modes: ['read'] }]

    await saveAcl({ path: '/bar/', actor: owner, rules })

    const custom = hoisted.getStore({ name: 'custom-acl' })
    expect(custom.entries.has('policy')).toBe(true)

    const audit = hoisted.getStore({ name: 'custom-audit' })
    const keys = [...audit.entries.keys()].filter((key) => key.startsWith('events/'))
    expect(keys).toHaveLength(1)

    expect(hoisted.getStore({ name: 'acl' }).entries.size).toBe(0)
    expect(hoisted.getStore({ name: 'acl-audit' }).entries.size).toBe(0)
  })
})
