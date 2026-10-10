import { loadAclConfig } from '../config.js'
import { openJsonStore } from './blobs.js'
import { loadPolicy, bootstrapPolicy } from './policy.js'
import type { PolicyDoc } from './policy.js'
import { authorize } from './authorize.js'
import type { AuthorizeResult } from './authorize.js'

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
