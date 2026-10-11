import type { JsonStore } from './blobs.js'
import type { LoadedPolicy, PolicyDoc } from './policy.js'
import { loadPolicy, POLICY_KEY, POLICY_SCHEMA } from './policy.js'
import { canonicalize } from './audit.js'

export class SnapshotError extends Error {}

export function serializeSnapshot(doc: PolicyDoc): string {
  return canonicalize(doc)
}

export function parseSnapshot(json: string): PolicyDoc {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new SnapshotError('snapshot is not valid JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SnapshotError('snapshot must be a JSON object')
  }
  const doc = parsed as PolicyDoc
  if (doc.schema !== POLICY_SCHEMA) {
    throw new SnapshotError(`snapshot schema ${String(doc.schema)} is not ${POLICY_SCHEMA}`)
  }
  return doc
}

export async function exportPolicySnapshot(store: JsonStore): Promise<string | null> {
  const loaded = await loadPolicy(store)
  if (loaded === null) return null
  return serializeSnapshot(loaded.doc)
}

export async function restorePolicySnapshot(
  store: JsonStore,
  json: string,
  options?: { onlyIfNew?: boolean; onlyIfMatch?: string }
): Promise<LoadedPolicy> {
  const doc = parseSnapshot(json)
  const result = await store.set(POLICY_KEY, doc, options)
  if (!result.modified) {
    throw new SnapshotError(
      'restore rejected: policy blob was not modified (existing policy or etag mismatch)'
    )
  }
  const loaded = await loadPolicy(store)
  if (loaded === null) throw new SnapshotError('policy missing after restore')
  return loaded
}
