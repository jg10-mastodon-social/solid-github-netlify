import { loadAclConfig } from '../config.js'
import { openJsonStore } from './blobs.js'
import {
  loadPolicy,
  bootstrapPolicy,
  resolveRuleset,
  applyEdit,
  setScopeRules,
  rulesetId
} from './policy.js'
import type { PolicyDoc } from './policy.js'
import { authorize } from './authorize.js'
import type { AuthorizeResult } from './authorize.js'
import { wacAllow } from './evaluate.js'
import type { Mode, Rule } from './evaluate.js'
import { appendEvent, listEvents } from './audit.js'
import type { AuditEvent } from './audit.js'

export interface RequestAuthInput {
  webId?: string
  method: string
  path: string
  containerPath?: string
  exists?: boolean
  insertOnly?: boolean
  isAcl?: boolean
}

export async function loadEffectivePolicy(): Promise<PolicyDoc> {
  const { ownerWebIds, aclStore } = loadAclConfig()
  const store = openJsonStore(aclStore)

  const loaded = await loadPolicy(store)
  if (loaded !== null) return loaded.doc

  const boot = await bootstrapPolicy(store, ownerWebIds)
  return boot.doc
}

export async function authorizeRequest(input: RequestAuthInput): Promise<AuthorizeResult> {
  const { ownerWebIds } = loadAclConfig()
  const doc = await loadEffectivePolicy()

  return authorize({ doc, ownerWebIds, ...input })
}

export async function wacAllowRequest(input: {
  webId?: string
  path: string
}): Promise<{ user: Mode[]; public: Mode[] }> {
  const doc = await loadEffectivePolicy()
  const ruleset = resolveRuleset(doc, input.path)
  return wacAllow(ruleset, { webId: input.webId })
}

export interface AclView {
  scopeKey: string
  resourceUri: string
  rules: Rule[]
  authored: boolean
}

export interface LoadAclInput {
  path: string
  resourceUri: string
}

export interface SaveAclInput {
  path: string
  actor: string
  rules: Rule[]
}

export async function loadAcl(input: LoadAclInput): Promise<AclView> {
  const doc = await loadEffectivePolicy()
  const entry = doc.scopes[input.path]
  const rules = entry === undefined ? [] : doc.rulesets[entry.self] ?? []

  return {
    scopeKey: input.path,
    resourceUri: input.resourceUri,
    rules,
    authored: entry !== undefined
  }
}

export async function saveAcl(input: SaveAclInput): Promise<void> {
  const { aclStore, aclAuditStore } = loadAclConfig()
  const store = openJsonStore(aclStore)
  await applyEdit(store, input.actor, (doc) => setScopeRules(doc, input.path, input.rules))

  const auditStore = openJsonStore(aclAuditStore)
  await appendEvent(auditStore, {
    ts: new Date().toISOString(),
    actor: input.actor,
    scope: input.path,
    op: 'replace',
    after: rulesetId(input.rules)
  })
}

export async function listAclAudit(): Promise<AuditEvent[]> {
  const { aclAuditStore } = loadAclConfig()
  const store = openJsonStore(aclAuditStore)
  return listEvents(store)
}
