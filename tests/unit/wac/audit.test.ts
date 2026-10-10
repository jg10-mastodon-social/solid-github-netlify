import { describe, it, expect } from 'vitest'
import type {
  JsonStore,
  BlobValue,
  SetOptions,
  WriteResult,
  StoreEntry
} from '../../../src/wac/blobs.js'
import type { AuditEvent, AuditEventInput } from '../../../src/wac/audit.js'
import {
  AUDIT_PREFIX,
  canonicalize,
  computeHash,
  eventKey,
  appendEvent,
  listEvents,
  verifyChain
} from '../../../src/wac/audit.js'

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

  seed(key: string, data: unknown): void {
    this.entries.set(key, { data, etag: this.nextEtag(), metadata: null })
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

function input(overrides: Partial<AuditEventInput> = {}): AuditEventInput {
  return {
    ts: '2026-10-08T12:00:00Z',
    actor: 'https://alice.example/profile#me',
    scope: '/alice/',
    op: 'grant',
    before: 'rs_prev',
    after: 'rs_priv_self',
    ...overrides
  }
}

function storedEvent(over: Partial<AuditEvent> = {}): AuditEvent {
  const { prevHash, hash, ...fields } = over
  const base = input(fields)
  const chainPrev = prevHash ?? null
  return { ...base, prevHash: chainPrev, hash: hash ?? computeHash(base, chainPrev) }
}

describe('AUDIT_PREFIX', () => {
  it('is the events prefix', () => {
    expect(AUDIT_PREFIX).toBe('events/')
  })
})

describe('canonicalize', () => {
  it('serializes objects with sorted keys', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
  })

  it('is order-independent for the same entries', () => {
    const a = { x: 1, y: { b: 2, a: 3 } }
    const b = { y: { a: 3, b: 2 }, x: 1 }
    expect(canonicalize(a)).toBe(canonicalize(b))
  })

  it('sorts keys recursively in nested objects and arrays', () => {
    const value = { z: [{ d: 4, c: 3 }], a: true }
    expect(canonicalize(value)).toBe('{"a":true,"z":[{"c":3,"d":4}]}')
  })

  it('preserves array order', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]')
  })

  it('serializes primitives and null', () => {
    expect(canonicalize('x')).toBe('"x"')
    expect(canonicalize(5)).toBe('5')
    expect(canonicalize(true)).toBe('true')
    expect(canonicalize(null)).toBe('null')
  })
})

describe('computeHash', () => {
  it('returns a 64-char lowercase hex sha256', () => {
    const hash = computeHash(input(), null)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('matches the sha256 of canonicalize(event) with an empty prefix for a null prevHash', () => {
    expect(computeHash(input(), null)).toBe(
      'a525107eb2acf992c6c44b7a2509a452c4c177d623ec431fcc843906963a431d'
    )
  })

  it('is deterministic for the same inputs', () => {
    expect(computeHash(input(), null)).toBe(computeHash(input(), null))
  })

  it('changes when any event field changes', () => {
    const base = computeHash(input(), null)
    expect(computeHash(input({ op: 'revoke' }), null)).not.toBe(base)
    expect(computeHash(input({ actor: 'https://bob.example/profile#me' }), null)).not.toBe(base)
    expect(computeHash(input({ after: 'rs_other' }), null)).not.toBe(base)
  })

  it('changes when the prevHash changes', () => {
    expect(computeHash(input(), 'ABC')).not.toBe(computeHash(input(), null))
  })

  it('folds the prevHash into the digest', () => {
    expect(computeHash(input(), 'PREVHASH')).toBe(
      '1038601af9eb1796d7355927fe8aaf652e466d00cc1042579c80c786e9797035'
    )
  })
})

describe('eventKey', () => {
  it('joins the prefix, timestamp and id with #', () => {
    expect(eventKey('2026-10-08T12:00:00Z', 'abc123')).toBe('events/2026-10-08T12:00:00Z#abc123')
  })
})

describe('appendEvent', () => {
  it('chains the first event from a null prevHash', async () => {
    const store = new FakeStore()
    const event = await appendEvent(store, input(), { id: 'id-1' })

    expect(event.prevHash).toBeNull()
    expect(event.hash).toBe(computeHash(input(), null))
    expect(event.ts).toBe('2026-10-08T12:00:00Z')
    expect(event.actor).toBe('https://alice.example/profile#me')
  })

  it('writes the event under the sortable key with onlyIfNew and hash metadata', async () => {
    const store = new FakeStore()
    const event = await appendEvent(store, input(), { id: 'id-1' })

    expect(store.setCalls).toHaveLength(1)
    expect(store.setCalls[0].key).toBe('events/2026-10-08T12:00:00Z#id-1')
    expect(store.setCalls[0].value).toEqual(event)
    expect(store.setCalls[0].options).toEqual({
      onlyIfNew: true,
      metadata: { hash: event.hash, prevHash: event.prevHash }
    })
  })

  it('chains the next event from the lexicographically last existing key', async () => {
    const store = new FakeStore()
    const first = storedEvent({ ts: '2026-10-01T00:00:00Z', op: 'grant' })
    const last = storedEvent({
      ts: '2026-10-05T00:00:00Z',
      op: 'replace',
      prevHash: first.hash
    })
    store.seed('events/2026-10-01T00:00:00Z#a', first)
    store.seed('events/2026-10-05T00:00:00Z#b', last)

    const event = await appendEvent(store, input({ ts: '2026-10-09T00:00:00Z' }), { id: 'c' })

    expect(event.prevHash).toBe(last.hash)
    expect(event.hash).toBe(computeHash(input({ ts: '2026-10-09T00:00:00Z' }), last.hash))
  })

  it('ignores non-events keys when finding the chain tip', async () => {
    const store = new FakeStore()
    store.seed('policy', { rev: 1 })
    store.seed('events/2026-10-01T00:00:00Z#a', storedEvent({ ts: '2026-10-01T00:00:00Z' }))

    const event = await appendEvent(store, input(), { id: 'c' })

    expect(event.prevHash).toBe(
      storedEvent({ ts: '2026-10-01T00:00:00Z' }).hash
    )
  })

  it('generates a uuid id by default', async () => {
    const store = new FakeStore()
    const event = await appendEvent(store, input())

    expect(store.setCalls[0].key).toMatch(
      /^events\/2026-10-08T12:00:00Z#[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    )
    expect(event.ts).toBe('2026-10-08T12:00:00Z')
  })

  it('returns the appended event and persists it', async () => {
    const store = new FakeStore()
    const event = await appendEvent(store, input(), { id: 'id-1' })

    const persisted = await store.get<AuditEvent>('events/2026-10-08T12:00:00Z#id-1')
    expect(persisted.data).toEqual(event)
  })
})

describe('listEvents', () => {
  it('returns an empty array when there are no events', async () => {
    expect(await listEvents(new FakeStore())).toEqual([])
  })

  it('reads every events/ value and returns them in key order', async () => {
    const store = new FakeStore()
    const second = storedEvent({ ts: '2026-10-05T00:00:00Z', op: 'replace' })
    const first = storedEvent({ ts: '2026-10-01T00:00:00Z', op: 'grant' })
    store.seed('events/2026-10-05T00:00:00Z#b', second)
    store.seed('events/2026-10-01T00:00:00Z#a', first)

    expect(await listEvents(store)).toEqual([first, second])
  })

  it('drops keys whose value is null', async () => {
    const store = new FakeStore()
    const present = storedEvent({ ts: '2026-10-01T00:00:00Z' })
    store.seed('events/2026-10-01T00:00:00Z#a', present)
    store.seed('events/2026-10-02T00:00:00Z#b', null)

    expect(await listEvents(store)).toEqual([present])
  })

  it('ignores keys outside the events prefix', async () => {
    const store = new FakeStore()
    const present = storedEvent({ ts: '2026-10-01T00:00:00Z' })
    store.seed('events/2026-10-01T00:00:00Z#a', present)
    store.seed('policy', { rev: 9 })

    expect(await listEvents(store)).toEqual([present])
  })
})

describe('verifyChain', () => {
  it('accepts an empty chain', () => {
    expect(verifyChain([])).toEqual({ valid: true, brokenAt: null })
  })

  it('accepts an intact chain', () => {
    const first = storedEvent({ ts: '2026-10-01T00:00:00Z', op: 'grant' })
    const second = storedEvent({
      ts: '2026-10-02T00:00:00Z',
      op: 'replace',
      prevHash: first.hash
    })
    expect(verifyChain([first, second])).toEqual({ valid: true, brokenAt: null })
  })

  it('flags a non-null prevHash at the head', () => {
    const first = storedEvent({ ts: '2026-10-01T00:00:00Z', prevHash: 'ghost' })
    expect(verifyChain([first])).toEqual({ valid: false, brokenAt: 0 })
  })

  it('flags a recomputed hash mismatch', () => {
    const first = storedEvent({ ts: '2026-10-01T00:00:00Z', hash: 'deadbeef' })
    expect(verifyChain([first])).toEqual({ valid: false, brokenAt: 0 })
  })

  it('flags the first broken link between events', () => {
    const first = storedEvent({ ts: '2026-10-01T00:00:00Z', op: 'grant' })
    const second = storedEvent({
      ts: '2026-10-02T00:00:00Z',
      op: 'replace',
      prevHash: first.hash
    })
    const third = storedEvent({
      ts: '2026-10-03T00:00:00Z',
      op: 'revoke',
      prevHash: 'wrong'
    })
    expect(verifyChain([first, second, third])).toEqual({ valid: false, brokenAt: 2 })
  })

  it('flags a tampered middle event at its own index', () => {
    const first = storedEvent({ ts: '2026-10-01T00:00:00Z', op: 'grant' })
    const second = storedEvent({
      ts: '2026-10-02T00:00:00Z',
      op: 'replace',
      prevHash: first.hash
    })
    const third = storedEvent({
      ts: '2026-10-03T00:00:00Z',
      op: 'revoke',
      prevHash: second.hash
    })
    const tampered: AuditEvent = { ...second, op: 'forged' }
    expect(verifyChain([first, tampered, third])).toEqual({ valid: false, brokenAt: 1 })
  })
})
