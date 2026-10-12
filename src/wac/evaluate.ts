export type Mode = 'read' | 'write' | 'append' | 'control'

export type Subject =
  | { class: 'public' }
  | { class: 'authenticated' }
  | { type: 'webid'; id: string }
  | { group: string }
  | { origin: string }

export interface Rule {
  subject: Subject
  modes: Mode[]
}

export interface ScopeEntry {
  self: string
  default: string
}

export type Scopes = Record<string, ScopeEntry>
export type Rulesets = Record<string, Rule[]>

export interface AgentContext {
  webId?: string
  groups?: Set<string>
  origin?: string
}

export interface ScopeResolution {
  scopeKey: string
  rulesetId: string
  isSelf: boolean
}

const MODE_ORDER: Mode[] = ['append', 'control', 'read', 'write']

function sortModes(modes: Iterable<Mode>): Mode[] {
  const set = new Set(modes)
  return MODE_ORDER.filter((mode) => set.has(mode))
}

function isContainerScope(scopeKey: string): boolean {
  return scopeKey === '' || scopeKey.endsWith('/')
}

function scopeMatches(scopeKey: string, path: string): boolean {
  if (isContainerScope(scopeKey)) {
    return scopeKey === '' || path.startsWith(scopeKey)
  }
  return path === scopeKey
}

export function resolveScope(path: string, scopes: Scopes): ScopeResolution | null {
  let best: string | null = null
  for (const scopeKey of Object.keys(scopes)) {
    if (!scopeMatches(scopeKey, path)) continue
    if (best === null || scopeKey.length > best.length) best = scopeKey
  }
  if (best === null) return null

  const entry = scopes[best]
  const resourcePath = best === '' ? '/' : best
  const isSelf = path === resourcePath
  return {
    scopeKey: best,
    rulesetId: isSelf ? entry.self : entry.default,
    isSelf
  }
}

export function matchesSubject(subject: Subject, ctx: AgentContext): boolean {
  if ('class' in subject) {
    if (subject.class === 'public') return true
    return ctx.webId !== undefined
  }
  if ('type' in subject) {
    return ctx.webId !== undefined && ctx.webId === subject.id
  }
  if ('group' in subject) {
    return ctx.groups !== undefined && ctx.groups.has(subject.group)
  }
  return ctx.origin !== undefined && ctx.origin === subject.origin
}

export function grantedModes(ruleset: Rule[], ctx: AgentContext): Set<Mode> {
  const granted = new Set<Mode>()
  for (const rule of ruleset) {
    if (!matchesSubject(rule.subject, ctx)) continue
    for (const mode of rule.modes) granted.add(mode)
  }
  return granted
}

export function satisfies(granted: ReadonlySet<Mode>, required: Mode): boolean {
  if (granted.has(required)) return true
  return required === 'append' && granted.has('write')
}

function expandAppend(modes: ReadonlySet<Mode>): Mode[] {
  const expanded = new Set(modes)
  if (expanded.has('write')) expanded.add('append')
  return sortModes(expanded)
}

export function wacAllow(ruleset: Rule[], ctx: AgentContext): { user: Mode[]; public: Mode[] } {
  const publicModes = grantedModes(ruleset, {})
  const userModes = grantedModes(ruleset, ctx)
  for (const mode of publicModes) userModes.add(mode)
  return { user: expandAppend(userModes), public: expandAppend(publicModes) }
}

export function requiredModes(opts: {
  method: string
  exists?: boolean
  insertOnly?: boolean
  isAcl?: boolean
}): { target: Mode; container?: Mode } {
  if (opts.isAcl) return { target: 'control' }
  switch (opts.method) {
    case 'GET':
    case 'HEAD':
      return { target: 'read' }
    case 'PUT':
      return opts.exists === true
        ? { target: 'write' }
        : { target: 'write', container: 'append' }
    case 'PATCH':
      return opts.insertOnly === true ? { target: 'append' } : { target: 'write' }
    case 'POST':
      return { target: 'append' }
    case 'DELETE':
      return { target: 'write' }
    default:
      return { target: 'write' }
  }
}
