import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockStore = {
  getWithMetadata: vi.fn(),
  setJSON: vi.fn(),
  list: vi.fn()
}
const mockGetStore = vi.fn((..._args: unknown[]) => mockStore)

vi.mock('@netlify/blobs', () => ({
  getStore: (...args: unknown[]) => mockGetStore(...args)
}))

import { openJsonStore } from '../../../src/wac/blobs.js'

beforeEach(() => {
  mockGetStore.mockClear()
  mockStore.getWithMetadata.mockReset()
  mockStore.setJSON.mockReset()
  mockStore.list.mockReset()
})

describe('openJsonStore', () => {
  it('opens the store with strong consistency by default', () => {
    openJsonStore('acl')
    expect(mockGetStore).toHaveBeenCalledWith({ name: 'acl', consistency: 'strong' })
  })

  it('opens the store with the requested consistency', () => {
    openJsonStore('acl', { consistency: 'eventual' })
    expect(mockGetStore).toHaveBeenCalledWith({ name: 'acl', consistency: 'eventual' })
  })
})

describe('get', () => {
  it('delegates to getWithMetadata with type json and maps the result', async () => {
    mockStore.getWithMetadata.mockResolvedValue({
      data: { schema: 1 },
      etag: 'etag-1',
      metadata: { rev: 3 }
    })
    const store = openJsonStore('acl')
    const result = await store.get('policy')
    expect(mockStore.getWithMetadata).toHaveBeenCalledWith('policy', { type: 'json' })
    expect(result).toEqual({ data: { schema: 1 }, etag: 'etag-1', metadata: { rev: 3 } })
  })

  it('returns nulls when the key is missing', async () => {
    mockStore.getWithMetadata.mockResolvedValue(null)
    const store = openJsonStore('acl')
    const result = await store.get('policy')
    expect(result).toEqual({ data: null, etag: null, metadata: null })
  })

  it('null-coalesces missing etag and metadata fields', async () => {
    mockStore.getWithMetadata.mockResolvedValue({ data: 42 })
    const store = openJsonStore('acl')
    const result = await store.get('policy')
    expect(result).toEqual({ data: 42, etag: null, metadata: null })
  })
})

describe('set', () => {
  it('delegates to setJSON with options and returns modified', async () => {
    mockStore.setJSON.mockResolvedValue({ modified: true })
    const store = openJsonStore('acl')
    const result = await store.set('policy', { schema: 1 }, { metadata: { rev: 1 }, onlyIfMatch: 'etag-1' })
    expect(mockStore.setJSON).toHaveBeenCalledWith('policy', { schema: 1 }, {
      metadata: { rev: 1 },
      onlyIfMatch: 'etag-1'
    })
    expect(result).toEqual({ modified: true })
  })

  it('omits undefined options', async () => {
    mockStore.setJSON.mockResolvedValue({ modified: false })
    const store = openJsonStore('acl')
    await store.set('policy', { schema: 1 })
    expect(mockStore.setJSON).toHaveBeenCalledWith('policy', { schema: 1 }, {})
  })

  it('forwards onlyIfNew when provided', async () => {
    mockStore.setJSON.mockResolvedValue({ modified: true })
    const store = openJsonStore('acl')
    await store.set('policy', { schema: 1 }, { onlyIfNew: true })
    expect(mockStore.setJSON).toHaveBeenCalledWith('policy', { schema: 1 }, { onlyIfNew: true })
  })

  it('returns modified false when the write is rejected', async () => {
    mockStore.setJSON.mockResolvedValue({ modified: false })
    const store = openJsonStore('acl')
    const result = await store.set('policy', { schema: 1 }, { onlyIfMatch: 'stale' })
    expect(result).toEqual({ modified: false })
  })
})

describe('list', () => {
  it('delegates to list with the prefix and maps the blobs', async () => {
    mockStore.list.mockResolvedValue({
      blobs: [
        { key: 'events/1', etag: 'etag-1', metadata: { rev: 1 } },
        { key: 'events/2' }
      ]
    })
    const store = openJsonStore('acl')
    const result = await store.list('events/')
    expect(mockStore.list).toHaveBeenCalledWith({ prefix: 'events/' })
    expect(result).toEqual([
      { key: 'events/1', etag: 'etag-1', metadata: null },
      { key: 'events/2', etag: null, metadata: null }
    ])
  })

  it('delegates with an undefined prefix when none is provided', async () => {
    mockStore.list.mockResolvedValue({ blobs: [] })
    const store = openJsonStore('acl')
    const result = await store.list()
    expect(mockStore.list).toHaveBeenCalledWith({ prefix: undefined })
    expect(result).toEqual([])
  })
})
