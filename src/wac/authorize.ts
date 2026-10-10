import type { AgentContext, Mode } from './evaluate.js'
import { grantedModes, requiredModes, satisfies } from './evaluate.js'
import type { PolicyDoc } from './policy.js'
import { resolveRuleset } from './policy.js'

export interface AuthorizeInput {
  doc: PolicyDoc
  webId?: string
  groups?: Set<string>
  origin?: string
  method: string
  path: string
  containerPath?: string
  exists?: boolean
  insertOnly?: boolean
  isAcl?: boolean
  ownerWebIds?: string[]
}

export interface AuthorizeResult {
  allowed: boolean
  required: { target: Mode; container?: Mode }
  granted: Mode[]
  ownerOverride: boolean
}

const MODE_ORDER: Mode[] = ['append', 'control', 'read', 'write']

export function parentContainerPath(path: string): string {
  if (path === '' || path === '/') return '/'
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path
  const lastSlash = trimmed.lastIndexOf('/')
  if (lastSlash <= 0) return '/'
  return trimmed.slice(0, lastSlash + 1)
}

export function authorize(input: AuthorizeInput): AuthorizeResult {
  const required = requiredModes({
    method: input.method,
    exists: input.exists,
    insertOnly: input.insertOnly,
    isAcl: input.isAcl
  })

  const ownerOverride =
    input.isAcl === true &&
    input.webId !== undefined &&
    (input.ownerWebIds ?? []).includes(input.webId)

  if (ownerOverride) {
    return { allowed: true, required, granted: [...MODE_ORDER], ownerOverride: true }
  }

  const ctx: AgentContext = { webId: input.webId, groups: input.groups, origin: input.origin }
  const targetGranted = grantedModes(resolveRuleset(input.doc, input.path), ctx)

  let containerGranted: Set<Mode> | null = null
  if (required.container !== undefined) {
    const container = input.containerPath ?? parentContainerPath(input.path)
    containerGranted = grantedModes(resolveRuleset(input.doc, container), ctx)
  }

  const allowed =
    satisfies(targetGranted, required.target) &&
    (required.container === undefined ||
      (containerGranted !== null && satisfies(containerGranted, required.container)))

  const granted = MODE_ORDER.filter((mode) => targetGranted.has(mode))

  return { allowed, required, granted, ownerOverride: false }
}
