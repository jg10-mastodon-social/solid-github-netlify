import { createHash } from 'node:crypto'
import type { JsonStore } from './blobs.js'
import type { Mode, Rule, Rulesets, Scopes } from './evaluate.js'
import { resolveScope } from './evaluate.js'
import { canonicalize } from './audit.js'

export interface PolicyDoc {
  schema: number
  rev: number
  updatedAt: string
  updatedBy: string
  scopes: Scopes
  rulesets: Rulesets
}

export const POLICY_KEY = 'policy'
export const POLICY_SCHEMA = 1

export interface LoadedPolicy {
  doc: PolicyDoc
  etag: string | null
}

export class PolicyNotBootstrappedError extends Error {}
export class PolicyConflictError extends Error {}

export async function loadPolicy(store: JsonStore): Promise<LoadedPolicy | null> {
  const result = await store.get<PolicyDoc>(POLICY_KEY)
  if (result.data === null) return null
  return { doc: result.data, etag: result.etag }
}

export async function bootstrapPolicy(
  store: JsonStore,
  ownerWebIds: string[],
  options?: { now?: string }
): Promise<LoadedPolicy> {
  const updatedAt = options?.now ?? new Date().toISOString()
  const ownerRules: Rule[] = ownerWebIds.map((id) => ({
    subject: { type: 'webid', id },
    modes: ['read', 'write', 'control'] as Mode[]
  }))
  const publicReadRule: Rule = { subject: { class: 'public' }, modes: ['read'] }
  const rootRules: Rule[] = [...ownerRules, publicReadRule]
  const doc: PolicyDoc = {
    schema: POLICY_SCHEMA,
    rev: 0,
    updatedAt,
    updatedBy: 'system',
    scopes: {
      '': { self: 'rs_root_self', default: 'rs_root_default' }
    },
    rulesets: {
      rs_root_self: rootRules,
      rs_root_default: rootRules
    }
  }

  const result = await store.set(POLICY_KEY, doc, { onlyIfNew: true, metadata: { rev: 0 } })

  if (!result.modified) {
    const existing = await loadPolicy(store)
    if (existing === null) throw new PolicyConflictError('policy bootstrap rejected but none found')
    return existing
  }

  const created = await loadPolicy(store)
  if (created === null) throw new PolicyNotBootstrappedError('policy missing after write')
  return created
}

export function resolveRuleset(doc: PolicyDoc, path: string): Rule[] {
  const resolution = resolveScope(path, doc.scopes)
  if (resolution === null) return []
  return doc.rulesets[resolution.rulesetId] ?? []
}

export function rulesetId(rules: Rule[]): string {
  const hash = createHash('sha256').update(canonicalize(rules)).digest('hex')
  return `rs_${hash.slice(0, 16)}`
}

export function setScopeRules(doc: PolicyDoc, scopeKey: string, rules: Rule[]): PolicyDoc {
  const id = rulesetId(rules)
  return {
    ...doc,
    scopes: { ...doc.scopes, [scopeKey]: { self: id, default: id } },
    rulesets: { ...doc.rulesets, [id]: rules }
  }
}

export async function applyEdit(
  store: JsonStore,
  actor: string,
  mutate: (doc: PolicyDoc) => PolicyDoc | null,
  options?: { now?: string; maxRetries?: number }
): Promise<{ doc: PolicyDoc; etag: string | null; changed: boolean }> {
  const maxRetries = options?.maxRetries ?? 3
  let loaded = await loadPolicy(store)

  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    if (loaded === null) throw new PolicyNotBootstrappedError('policy not bootstrapped')

    const { doc, etag } = loaded
    const mutated = mutate(doc)
    if (mutated === null) return { doc, etag, changed: false }

    const updatedAt = options?.now ?? new Date().toISOString()
    const next: PolicyDoc = { ...mutated, rev: doc.rev + 1, updatedAt, updatedBy: actor }

    const result = await store.set(POLICY_KEY, next, {
      onlyIfMatch: etag ?? undefined,
      metadata: { rev: next.rev, updatedAt, updatedBy: actor }
    })

    if (result.modified) {
      const reloaded = await loadPolicy(store)
      return { doc: next, etag: reloaded?.etag ?? null, changed: true }
    }

    loaded = await loadPolicy(store)
  }

  throw new PolicyConflictError('policy edit conflicted too many times')
}
