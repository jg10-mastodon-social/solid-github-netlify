import { getStore } from '@netlify/blobs'

export type Consistency = 'strong' | 'eventual'

export interface BlobValue<T> {
  data: T | null
  etag: string | null
  metadata: Record<string, unknown> | null
}

export interface SetOptions {
  metadata?: Record<string, unknown>
  onlyIfNew?: boolean
  onlyIfMatch?: string
}

export interface WriteResult {
  modified: boolean
}

export interface StoreEntry {
  key: string
  etag: string | null
  metadata: Record<string, unknown> | null
}

export interface JsonStore {
  get<T>(key: string): Promise<BlobValue<T>>
  set<T>(key: string, value: T, options?: SetOptions): Promise<WriteResult>
  list(prefix?: string): Promise<StoreEntry[]>
}

export function openJsonStore(
  name: string,
  options?: { consistency?: Consistency }
): JsonStore {
  const store = getStore({
    name,
    consistency: options?.consistency ?? 'strong'
  })

  return {
    async get<T>(key: string): Promise<BlobValue<T>> {
      const result = await store.getWithMetadata(key, { type: 'json' })
      if (result === null) {
        return { data: null, etag: null, metadata: null }
      }
      return {
        data: (result.data as T | undefined) ?? null,
        etag: result.etag ?? null,
        metadata: result.metadata ?? null
      }
    },

    async set<T>(key: string, value: T, options?: SetOptions): Promise<WriteResult> {
      const metadata = options?.metadata
      const base = metadata !== undefined ? { metadata } : {}
      const setOptions: Parameters<typeof store.setJSON>[2] =
        options?.onlyIfNew !== undefined
          ? { ...base, onlyIfNew: options.onlyIfNew }
          : options?.onlyIfMatch !== undefined
            ? { ...base, onlyIfMatch: options.onlyIfMatch }
            : base
      const result = await store.setJSON(key, value, setOptions)
      return { modified: result.modified }
    },

    async list(prefix?: string): Promise<StoreEntry[]> {
      const result = await store.list({ prefix })
      return result.blobs.map((blob) => ({
        key: blob.key,
        etag: blob.etag ?? null,
        metadata: null
      }))
    }
  }
}
