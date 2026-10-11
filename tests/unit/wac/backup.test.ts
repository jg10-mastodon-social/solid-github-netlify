import { describe, it, expect } from 'vitest'
import type {
  JsonStore,
  BlobValue,
  SetOptions,
  WriteResult,
  StoreEntry
} from '../../../src/wac/blobs.js'
import type { PolicyDoc } from '../../../src/wac/policy.js'
import { POLICY_KEY, POLICY_SCHEMA, bootstrapPolicy } from '../../../src/wac/policy.js'
import { canonicalize } from '../../../src/wac/audit.js'
import {
  SnapshotError,
  parseSnapshot,
  serializeSnapshot,
  exportPolicySnapshot,
  restorePolicySnapshot
} from '../../../src/wac/backup.js'

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
    schema: POLICY_SCHEMA,
    rev: 3,
    updatedAt: '2026-10-10T00:00:00.000Z',
    updatedBy: 'https://alice.example/profile#me',
    scopes: { '': { self: 'rs_root_self', default: 'rs_root_default' } },
    rulesets: {
      rs_root_self: [{ subject: { class: 'public' }, modes: ['read'] }],
      rs_root_default: [{ subject: { class: 'public' }, modes: ['read'] }]
    },
    ...overrides
  }
}

describe('serializeSnapshot', () => {
  it('canonicalizes the policy document', () => {
    const doc = policyDoc()
    expect(serializeSnapshot(doc)).toBe(canonicalize(doc))
  })

  it('sorts keys so equal documents serialize identically', () => {
    const a = policyDoc()
    const b = policyDoc({ rulesets: a.rulesets, scopes: a.scopes })
    expect(serializeSnapshot(a)).toBe(serializeSnapshot(b))
  })
})

describe('parseSnapshot', () => {
  it('round-trips a serialized document', () => {
    const doc = policyDoc()
    expect(parseSnapshot(serializeSnapshot(doc))).toEqual(doc)
  })

  it('rejects a document with the wrong schema', () => {
    const raw = JSON.stringify(policyDoc({ schema: 99 }))
    expect(() => parseSnapshot(raw)).toThrow(SnapshotError)
  })

  it('rejects a missing schema', () => {
    expect(() => parseSnapshot('{"rev":1}')).toThrow(SnapshotError)
  })

  it('rejects invalid JSON', () => {
    expect(() => parseSnapshot('not json')).toThrow(SnapshotError)
  })

  it('rejects a non-object payload', () => {
    expect(() => parseSnapshot('[]')).toThrow(SnapshotError)
  })
})

describe('exportPolicySnapshot', () => {
  it('returns null when no policy is present', async () => {
    expect(await exportPolicySnapshot(new FakeStore())).toBeNull()
  })

  it('returns canonical JSON for a bootstrapped policy', async () => {
    const store = new FakeStore()
    const { doc } = await bootstrapPolicy(store, ['https://alice.example/profile#me'], {
      now: '2026-10-10T00:00:00.000Z'
    })

    expect(await exportPolicySnapshot(store)).toBe(canonicalize(doc))
  })
})

describe('restorePolicySnapshot', () => {
  it('writes the snapshot into the policy blob and returns it', async () => {
    const store = new FakeStore()
    const doc = policyDoc()

    const loaded = await restorePolicySnapshot(store, serializeSnapshot(doc))

    expect(loaded.doc).toEqual(doc)
    expect(store.setCalls).toHaveLength(1)
    expect(store.setCalls[0].key).toBe(POLICY_KEY)
    expect(store.setCalls[0].value).toEqual(doc)
  })

  it('re-reads to obtain the etag after writing', async () => {
    const store = new FakeStore()
    const doc = policyDoc()
    const loaded = await restorePolicySnapshot(store, serializeSnapshot(doc))
    const stored = await store.get<PolicyDoc>(POLICY_KEY)
    expect(loaded.etag).toBe(stored.etag)
  })

  it('forwards onlyIfNew so it refuses to overwrite an existing policy', async () => {
    const store = new FakeStore({ [POLICY_KEY]: policyDoc({ rev: 9 }) })
    const incoming = policyDoc({ rev: 1 })

    await expect(
      restorePolicySnapshot(store, serializeSnapshot(incoming), { onlyIfNew: true })
    ).rejects.toBeInstanceOf(SnapshotError)

    expect(store.setCalls[0].options).toEqual({ onlyIfNew: true })
    expect((await store.get<PolicyDoc>(POLICY_KEY)).data?.rev).toBe(9)
  })

  it('honours onlyIfMatch and overwrites with the matching etag', async () => {
    const store = new FakeStore({ [POLICY_KEY]: policyDoc({ rev: 2 }) })
    const incoming = policyDoc({ rev: 5 })

    const loaded = await restorePolicySnapshot(store, serializeSnapshot(incoming), {
      onlyIfMatch: 'etag-1'
    })

    expect(loaded.doc.rev).toBe(5)
    expect(store.setCalls[0].options).toEqual({ onlyIfMatch: 'etag-1' })
  })

  it('throws SnapshotError when onlyIfMatch is rejected', async () => {
    const store = new FakeStore({ [POLICY_KEY]: policyDoc({ rev: 2 }) })
    const incoming = policyDoc({ rev: 5 })

    await expect(
      restorePolicySnapshot(store, serializeSnapshot(incoming), { onlyIfMatch: 'stale' })
    ).rejects.toBeInstanceOf(SnapshotError)
    expect((await store.get<PolicyDoc>(POLICY_KEY)).data?.rev).toBe(2)
  })

  it('rejects a snapshot with the wrong schema before writing', async () => {
    const store = new FakeStore()
    const raw = JSON.stringify(policyDoc({ schema: 2 }))

    await expect(restorePolicySnapshot(store, raw)).rejects.toBeInstanceOf(SnapshotError)
    expect(store.setCalls).toHaveLength(0)
  })
})
