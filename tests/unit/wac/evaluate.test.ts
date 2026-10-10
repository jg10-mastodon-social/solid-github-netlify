import { describe, it, expect } from 'vitest'
import {
  resolveScope,
  matchesSubject,
  grantedModes,
  satisfies,
  wacAllow,
  requiredModes,
  type Scopes,
  type Rulesets,
  type Rule,
  type AgentContext
} from '../../../src/wac/evaluate.js'

const scopes: Scopes = {
  '': { self: 'rs_root_self', default: 'rs_root_def' },
  '/alice/': { self: 'rs_alice_self', default: 'rs_alice_def' },
  '/alice/private/': { self: 'rs_priv_self', default: 'rs_priv_def' }
}

describe('resolveScope', () => {
  it('resolves the root container itself to its self ruleset', () => {
    expect(resolveScope('/', { '': { self: 'rs_root_self', default: 'rs_root_def' } })).toEqual({
      scopeKey: '',
      rulesetId: 'rs_root_self',
      isSelf: true
    })
  })

  it('resolves an unrelated path to the root default ruleset', () => {
    expect(resolveScope('/bob/profile.ttl', scopes)).toEqual({
      scopeKey: '',
      rulesetId: 'rs_root_def',
      isSelf: false
    })
  })

  it('resolves a container scope to its self ruleset', () => {
    expect(resolveScope('/alice/', scopes)).toEqual({
      scopeKey: '/alice/',
      rulesetId: 'rs_alice_self',
      isSelf: true
    })
  })

  it('resolves a descendant to its container default ruleset', () => {
    expect(resolveScope('/alice/profile.ttl', scopes)).toEqual({
      scopeKey: '/alice/',
      rulesetId: 'rs_alice_def',
      isSelf: false
    })
  })

  it('does not let a container scope prefix-match a path without the trailing slash', () => {
    expect(resolveScope('/alice', scopes)).toEqual({
      scopeKey: '',
      rulesetId: 'rs_root_def',
      isSelf: false
    })
  })

  it('chooses the longest matching prefix', () => {
    expect(resolveScope('/alice/private/x', scopes)).toEqual({
      scopeKey: '/alice/private/',
      rulesetId: 'rs_priv_def',
      isSelf: false
    })
  })

  it('returns null for empty scopes', () => {
    expect(resolveScope('/anything', {})).toBeNull()
  })

  it('matches a non-slash scope key exactly as a resource scope', () => {
    const resourceScopes: Scopes = {
      '': { self: 'rs_root_self', default: 'rs_root_def' },
      '/alice/profile.ttl': { self: 'rs_file_self', default: 'rs_file_def' }
    }
    expect(resolveScope('/alice/profile.ttl', resourceScopes)).toEqual({
      scopeKey: '/alice/profile.ttl',
      rulesetId: 'rs_file_self',
      isSelf: true
    })
    expect(resolveScope('/alice/profile.json', resourceScopes)).toEqual({
      scopeKey: '',
      rulesetId: 'rs_root_def',
      isSelf: false
    })
  })
})

describe('matchesSubject', () => {
  it('matches public even for an empty context', () => {
    expect(matchesSubject({ class: 'public' }, {})).toBe(true)
  })

  it('matches authenticated only when a webId is present', () => {
    expect(matchesSubject({ class: 'authenticated' }, {})).toBe(false)
    expect(matchesSubject({ class: 'authenticated' }, { webId: 'https://alice.example/#me' })).toBe(
      true
    )
  })

  it('matches a webid only on an exact id', () => {
    const subject = { type: 'webid' as const, id: 'https://alice.example/profile#me' }
    expect(matchesSubject(subject, {})).toBe(false)
    expect(matchesSubject(subject, { webId: 'https://alice.example/profile#me' })).toBe(true)
    expect(matchesSubject(subject, { webId: 'https://bob.example/profile#me' })).toBe(false)
  })

  it('matches a group only when the context belongs to it', () => {
    const subject = { group: 'https://alice.example/groups#friends' }
    expect(matchesSubject(subject, {})).toBe(false)
    expect(matchesSubject(subject, { groups: new Set(['other']) })).toBe(false)
    expect(
      matchesSubject(subject, {
        groups: new Set(['https://alice.example/groups#friends'])
      })
    ).toBe(true)
  })

  it('matches an origin only when the context origin equals it', () => {
    const subject = { origin: 'https://app.example' }
    expect(matchesSubject(subject, {})).toBe(false)
    expect(matchesSubject(subject, { origin: 'https://evil.example' })).toBe(false)
    expect(matchesSubject(subject, { origin: 'https://app.example' })).toBe(true)
  })
})

describe('grantedModes', () => {
  it('unions modes across all matching rules and ignores non-matching rules', () => {
    const ruleset: Rule[] = [
      { subject: { class: 'public' }, modes: ['read'] },
      {
        subject: { type: 'webid', id: 'https://alice.example/profile#me' },
        modes: ['write', 'control']
      },
      {
        subject: { type: 'webid', id: 'https://bob.example/profile#me' },
        modes: ['read', 'write']
      }
    ]
    const granted = grantedModes(ruleset, { webId: 'https://alice.example/profile#me' })
    expect(granted).toBeInstanceOf(Set)
    expect([...granted].sort()).toEqual(['control', 'read', 'write'])
  })

  it('returns an empty set when nothing matches', () => {
    const ruleset: Rule[] = [
      { subject: { type: 'webid', id: 'https://alice.example/profile#me' }, modes: ['read'] }
    ]
    expect(grantedModes(ruleset, {})).toEqual(new Set())
  })
})

describe('satisfies', () => {
  it('satisfies the same mode', () => {
    expect(satisfies(new Set(['read']), 'read')).toBe(true)
  })

  it('treats append as a subclass of write', () => {
    expect(satisfies(new Set(['write']), 'append')).toBe(true)
  })

  it('does not let append satisfy a write requirement', () => {
    expect(satisfies(new Set(['append']), 'write')).toBe(false)
  })

  it('does not let read satisfy a write requirement', () => {
    expect(satisfies(new Set(['read']), 'write')).toBe(false)
  })
})

describe('wacAllow', () => {
  const ruleset: Rule[] = [
    { subject: { class: 'public' }, modes: ['read'] },
    { subject: { type: 'webid', id: 'https://alice.example/profile#me' }, modes: ['write'] }
  ]

  it('unions the agent modes with the public modes and sorts them', () => {
    const result = wacAllow(ruleset, { webId: 'https://alice.example/profile#me' })
    expect(result).toEqual({ user: ['read', 'write'], public: ['read'] })
  })

  it('reports the public modes under both user and public for anonymous callers', () => {
    expect(wacAllow(ruleset, {})).toEqual({ user: ['read'], public: ['read'] })
  })

  it('deduplicates and alphabetises modes', () => {
    const duplicated: Rule[] = [
      { subject: { class: 'public' }, modes: ['write', 'read'] },
      { subject: { class: 'public' }, modes: ['read'] },
      { subject: { class: 'authenticated' }, modes: ['control'] }
    ]
    expect(wacAllow(duplicated, { webId: 'https://alice.example/profile#me' })).toEqual({
      user: ['control', 'read', 'write'],
      public: ['read', 'write']
    })
  })
})

describe('requiredModes', () => {
  it('requires control for any ACL resource regardless of method', () => {
    expect(requiredModes({ method: 'GET', isAcl: true })).toEqual({ target: 'control' })
    expect(requiredModes({ method: 'PUT', isAcl: true })).toEqual({ target: 'control' })
    expect(requiredModes({ method: 'DELETE', isAcl: true })).toEqual({ target: 'control' })
  })

  it('requires read for GET and HEAD', () => {
    expect(requiredModes({ method: 'GET' })).toEqual({ target: 'read' })
    expect(requiredModes({ method: 'HEAD' })).toEqual({ target: 'read' })
  })

  it('requires write on the target for a PUT replacing an existing resource', () => {
    expect(requiredModes({ method: 'PUT', exists: true })).toEqual({ target: 'write' })
  })

  it('requires write on the target and append on the container when creating via PUT', () => {
    expect(requiredModes({ method: 'PUT', exists: false })).toEqual({
      target: 'write',
      container: 'append'
    })
  })

  it('requires append for an insert-only PATCH', () => {
    expect(requiredModes({ method: 'PATCH', insertOnly: true })).toEqual({ target: 'append' })
  })

  it('requires write for a general PATCH', () => {
    expect(requiredModes({ method: 'PATCH' })).toEqual({ target: 'write' })
  })

  it('requires append for POST', () => {
    expect(requiredModes({ method: 'POST' })).toEqual({ target: 'append' })
  })

  it('requires write for DELETE', () => {
    expect(requiredModes({ method: 'DELETE' })).toEqual({ target: 'write' })
  })
})
