import { describe, it, expect } from 'vitest'
import type {
  JsonStore,
  BlobValue,
  SetOptions,
  WriteResult,
  StoreEntry
} from '../../../src/wac/blobs.js'
import type { PolicyDoc } from '../../../src/wac/policy.js'
import type { Rule } from '../../../src/wac/evaluate.js'
import {
  loadPolicy,
  bootstrapPolicy,
  resolveRuleset,
  applyEdit,
  rulesetId,
  setScopeRules,
  PolicyNotBootstrappedError,
  PolicyConflictError,
  POLICY_KEY,
  POLICY_SCHEMA
} from '../../../src/wac/policy.js'

interface Entry {
  data: unknown
  etag: string
  metadata: Record<string, unknown> | null
}

interface SetCall {
  key: string
  value: unknown
  options?: SetOptions
}

class FakeStore implements JsonStore {
  entries = new Map<string, Entry>()
  setCalls: SetCall[] = []
  conflictOnNextSet = 0
  private counter = 0

  constructor(initial?: Record<string, unknown>) {
    if (initial !== undefined) {
      for (const [key, data] of Object.entries(initial)) {
        this.entries.set(key, { data, etag: this.nextEtag(), metadata: null })
      }
    }
  }

  private nextEtag(): string {
    this.counter += 1
    return `etag-${this.counter}`
  }

  async get<T>(key: string): Promise<BlobValue<T>> {
    const entry = this.entries.get(key)
    if (entry === undefined) return { data: null, etag: null, metadata: null }
    return { data: entry.data as T, etag: entry.etag, metadata: entry.metadata }
  }

  async set<T>(key: string, value: T, options?: SetOptions): Promise<WriteResult> {
    this.setCalls.push({ key, value, options })
    if (this.conflictOnNextSet > 0) {
      this.conflictOnNextSet -= 1
      return { modified: false }
    }
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

  async list(prefix?: string): Promise<StoreEntry[]> {
    return [...this.entries.entries()]
      .filter(([key]) => prefix === undefined || key.startsWith(prefix))
      .map(([key, entry]) => ({ key, etag: entry.etag, metadata: entry.metadata }))
  }
}

function policyDoc(overrides: Partial<PolicyDoc> = {}): PolicyDoc {
  return {
    schema: 1,
    rev: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
    updatedBy: 'system',
    scopes: { '': { self: 'rs_root_self', default: 'rs_root_default' } },
    rulesets: {
      rs_root_self: [{ subject: { class: 'public' }, modes: ['read'] }],
      rs_root_default: [{ subject: { class: 'public' }, modes: ['read'] }]
    },
    ...overrides
  }
}

describe('constants', () => {
  it('exposes the policy key and schema', () => {
    expect(POLICY_KEY).toBe('policy')
    expect(POLICY_SCHEMA).toBe(1)
  })
})

describe('loadPolicy', () => {
  it('returns null when the policy blob is absent', async () => {
    const store = new FakeStore()
    expect(await loadPolicy(store)).toBeNull()
  })

  it('returns the document and etag from the store', async () => {
    const doc = policyDoc()
    const store = new FakeStore({ [POLICY_KEY]: doc })
    const loaded = await loadPolicy(store)
    expect(loaded).not.toBeNull()
    expect(loaded?.doc).toEqual(doc)
    expect(loaded?.etag).toBe('etag-1')
  })
})

describe('bootstrapPolicy', () => {
  it('creates the root policy with an owner-granting ruleset', async () => {
    const store = new FakeStore()
    const owners = ['https://alice.example/profile#me', 'https://bob.example/profile#me']

    const { doc, etag } = await bootstrapPolicy(store, owners, { now: '2026-10-10T00:00:00.000Z' })

    expect(doc.schema).toBe(POLICY_SCHEMA)
    expect(doc.rev).toBe(0)
    expect(doc.updatedAt).toBe('2026-10-10T00:00:00.000Z')
    expect(doc.updatedBy).toBe('system')
    expect(doc.scopes).toEqual({
      '': { self: 'rs_root_self', default: 'rs_root_default' }
    })

    const ownerRules = owners.map((id) => ({
      subject: { type: 'webid', id },
      modes: ['read', 'write', 'control']
    }))
    expect(doc.rulesets.rs_root_self).toEqual(ownerRules)
    expect(doc.rulesets.rs_root_default).toEqual(ownerRules)
    expect(etag).toBe('etag-1')
  })

  it('writes with onlyIfNew and rev metadata', async () => {
    const store = new FakeStore()
    await bootstrapPolicy(store, [], { now: '2026-10-10T00:00:00.000Z' })

    expect(store.setCalls).toHaveLength(1)
    expect(store.setCalls[0].key).toBe(POLICY_KEY)
    expect(store.setCalls[0].options).toEqual({ onlyIfNew: true, metadata: { rev: 0 } })
  })

  it('defaults updatedAt to the current time', async () => {
    const store = new FakeStore()
    const before = new Date().toISOString()
    const { doc } = await bootstrapPolicy(store, [])
    const after = new Date().toISOString()
    expect(doc.updatedAt >= before).toBe(true)
    expect(doc.updatedAt <= after).toBe(true)
  })

  it('re-reads to obtain the etag after creating', async () => {
    const store = new FakeStore()
    const { etag } = await bootstrapPolicy(store, [])
    const stored = await store.get<PolicyDoc>(POLICY_KEY)
    expect(etag).toBe(stored.etag)
  })

  it('returns the existing policy when one is already present', async () => {
    const existing = policyDoc({ rev: 7, updatedBy: 'https://alice.example/profile#me' })
    const store = new FakeStore({ [POLICY_KEY]: existing })

    const { doc, etag } = await bootstrapPolicy(store, ['https://new.example/profile#me'])

    expect(doc).toEqual(existing)
    expect(etag).toBe('etag-1')
    expect(store.setCalls).toHaveLength(1)
    expect(store.setCalls[0].options).toEqual({ onlyIfNew: true, metadata: { rev: 0 } })
  })
})

describe('resolveRuleset', () => {
  it('resolves the root scope self ruleset for the root path', () => {
    const doc = policyDoc()
    expect(resolveRuleset(doc, '/')).toEqual(doc.rulesets.rs_root_self)
  })

  it('resolves descendants to the default ruleset', () => {
    const doc = policyDoc()
    expect(resolveRuleset(doc, '/foo/bar.ttl')).toEqual(doc.rulesets.rs_root_default)
  })

  it('returns an empty array when the ruleset id is unknown', () => {
    const doc = policyDoc({ rulesets: {} })
    expect(resolveRuleset(doc, '/')).toEqual([])
  })

  it('returns an empty array when resolveScope returns null', () => {
    const doc = policyDoc({ scopes: {} })
    expect(resolveRuleset(doc, '/anything')).toEqual([])
  })
})

describe('applyEdit', () => {
  it('throws PolicyNotBootstrappedError when no policy exists', async () => {
    const store = new FakeStore()
    await expect(applyEdit(store, 'actor', (doc) => doc)).rejects.toBeInstanceOf(
      PolicyNotBootstrappedError
    )
    expect(store.setCalls).toHaveLength(0)
  })

  it('returns changed false and skips the write when mutate returns null', async () => {
    const doc = policyDoc()
    const store = new FakeStore({ [POLICY_KEY]: doc })

    const result = await applyEdit(store, 'actor', () => null)

    expect(result).toEqual({ doc, etag: 'etag-1', changed: false })
    expect(store.setCalls).toHaveLength(0)
  })

  it('bumps rev, stamps the actor and writes with the etag precondition', async () => {
    const doc = policyDoc({ rev: 4 })
    const store = new FakeStore({ [POLICY_KEY]: doc })
    const nextRulesets = { rs_next: [{ subject: { class: 'public' }, modes: ['read'] }] as Rule[] }
    const mutate = (current: PolicyDoc): PolicyDoc => ({ ...current, rulesets: nextRulesets })

    const result = await applyEdit(store, 'https://alice.example/profile#me', mutate, {
      now: '2026-10-10T12:00:00.000Z'
    })

    expect(result.changed).toBe(true)
    expect(result.doc.rev).toBe(5)
    expect(result.doc.rulesets).toEqual(nextRulesets)
    expect(result.doc.updatedAt).toBe('2026-10-10T12:00:00.000Z')
    expect(result.doc.updatedBy).toBe('https://alice.example/profile#me')
    expect(result.etag).toBe('etag-2')

    expect(store.setCalls).toHaveLength(1)
    expect(store.setCalls[0].key).toBe(POLICY_KEY)
    expect(store.setCalls[0].value).toEqual(result.doc)
    expect(store.setCalls[0].options).toEqual({
      onlyIfMatch: 'etag-1',
      metadata: {
        rev: 5,
        updatedAt: '2026-10-10T12:00:00.000Z',
        updatedBy: 'https://alice.example/profile#me'
      }
    })
  })

  it('re-reads to obtain the new etag after a successful write', async () => {
    const store = new FakeStore({ [POLICY_KEY]: policyDoc() })
    const result = await applyEdit(store, 'actor', (doc) => ({ ...doc, rev: 99 }))
    const stored = await store.get<PolicyDoc>(POLICY_KEY)
    expect(result.etag).toBe(stored.etag)
  })

  it('re-loads and retries the mutate after a CAS conflict', async () => {
    const store = new FakeStore({ [POLICY_KEY]: policyDoc({ rev: 2 }) })
    store.conflictOnNextSet = 1
    const mutate = (doc: PolicyDoc): PolicyDoc => ({ ...doc, updatedBy: doc.updatedBy })

    const result = await applyEdit(store, 'actor', mutate)

    expect(result.changed).toBe(true)
    expect(result.doc.rev).toBe(3)
    expect(store.setCalls).toHaveLength(2)
  })

  it('throws PolicyConflictError after exhausting the default retries', async () => {
    const store = new FakeStore({ [POLICY_KEY]: policyDoc() })
    store.conflictOnNextSet = 99

    await expect(applyEdit(store, 'actor', (doc) => doc)).rejects.toBeInstanceOf(
      PolicyConflictError
    )
    expect(store.setCalls).toHaveLength(3)
  })

  it('honours a custom maxRetries', async () => {
    const store = new FakeStore({ [POLICY_KEY]: policyDoc() })
    store.conflictOnNextSet = 99

    await expect(
      applyEdit(store, 'actor', (doc) => doc, { maxRetries: 1 })
    ).rejects.toBeInstanceOf(PolicyConflictError)
    expect(store.setCalls).toHaveLength(1)
  })

  it('uses the mutated document from the reloaded policy on retry', async () => {
    const store = new FakeStore({ [POLICY_KEY]: policyDoc({ rev: 2 }) })
    store.conflictOnNextSet = 1
    const seen: number[] = []
    const mutate = (doc: PolicyDoc): PolicyDoc => {
      seen.push(doc.rev)
      return { ...doc }
    }

    await applyEdit(store, 'actor', mutate)

    expect(seen).toEqual([2, 2])
  })
})

describe('rulesetId', () => {
  const rules: Rule[] = [
    { subject: { type: 'webid', id: 'https://alice.example/profile#me' }, modes: ['read', 'write'] },
    { subject: { class: 'public' }, modes: ['read'] }
  ]

  it('is content-addressed with the rs_ prefix', () => {
    expect(rulesetId(rules)).toMatch(/^rs_[0-9a-f]{16}$/)
  })

  it('is stable for equal rules regardless of key order', () => {
    const reordered: Rule[] = [
      { modes: ['read', 'write'], subject: { type: 'webid', id: 'https://alice.example/profile#me' } },
      { modes: ['read'], subject: { class: 'public' } }
    ]
    expect(rulesetId(reordered)).toBe(rulesetId(rules))
  })

  it('differs for different rules', () => {
    const other: Rule[] = [{ subject: { class: 'public' }, modes: ['read', 'write'] }]
    expect(rulesetId(other)).not.toBe(rulesetId(rules))
  })
})

describe('setScopeRules', () => {
  const rules: Rule[] = [{ subject: { class: 'public' }, modes: ['read'] }]

  it('creates a new scope and ruleset without mutating the input', () => {
    const doc = policyDoc()
    const snapshot = JSON.parse(JSON.stringify(doc))
    const id = rulesetId(rules)

    const next = setScopeRules(doc, '/alice/', rules)

    expect(next).not.toBe(doc)
    expect(doc).toEqual(snapshot)
    expect(next.scopes['/alice/']).toEqual({ self: id, default: id })
    expect(next.rulesets[id]).toEqual(rules)
  })

  it('updates an existing scope while preserving other scopes and rulesets', () => {
    const id = rulesetId(rules)
    const doc = policyDoc({
      scopes: {
        '': { self: 'rs_root_self', default: 'rs_root_default' },
        '/alice/': { self: 'rs_old_self', default: 'rs_old_default' }
      }
    })

    const next = setScopeRules(doc, '/alice/', rules)

    expect(next.scopes['']).toEqual({ self: 'rs_root_self', default: 'rs_root_default' })
    expect(next.scopes['/alice/']).toEqual({ self: id, default: id })
    expect(next.rulesets.rs_root_self).toEqual(doc.rulesets.rs_root_self)
    expect(next.rulesets[id]).toEqual(rules)
  })
})
