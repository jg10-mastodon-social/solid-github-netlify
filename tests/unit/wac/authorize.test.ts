import { describe, it, expect } from 'vitest'
import type { Rule, Rulesets, Scopes } from '../../../src/wac/evaluate.js'
import type { PolicyDoc } from '../../../src/wac/policy.js'
import { authorize, parentContainerPath } from '../../../src/wac/authorize.js'

const alice = 'https://alice.example/profile#me'
const owner = 'https://owner.example/profile#me'

function makeDoc(scopes: Scopes, rulesets: Rulesets): PolicyDoc {
  return {
    schema: 1,
    rev: 0,
    updatedAt: '2026-01-01T00:00:00Z',
    updatedBy: 'test',
    scopes,
    rulesets
  }
}

function webidGrant(id: string, modes: Rule['modes']): Rule {
  return { subject: { type: 'webid', id }, modes }
}

const scopes: Scopes = {
  '': { self: 'rs_root_self', default: 'rs_root_def' },
  '/alice/': { self: 'rs_alice_self', default: 'rs_alice_def' },
  '/shared/': { self: 'rs_shared_self', default: 'rs_shared_def' }
}

describe('parentContainerPath', () => {
  it('returns the containing container for a resource', () => {
    expect(parentContainerPath('/alice/profile.ttl')).toBe('/alice/')
  })

  it('returns the root for a top-level container', () => {
    expect(parentContainerPath('/alice/')).toBe('/')
  })

  it('returns the root for a top-level slug', () => {
    expect(parentContainerPath('/alice')).toBe('/')
  })

  it('returns the root for the root itself', () => {
    expect(parentContainerPath('/')).toBe('/')
  })
})

describe('authorize GET', () => {
  it('denies without a matching read grant', () => {
    const doc = makeDoc(scopes, { rs_alice_def: [] })
    const result = authorize({ doc, webId: alice, method: 'GET', path: '/alice/profile.ttl' })
    expect(result).toEqual({
      allowed: false,
      required: { target: 'read' },
      granted: [],
      ownerOverride: false
    })
  })

  it('allows with a read grant', () => {
    const doc = makeDoc(scopes, { rs_alice_def: [webidGrant(alice, ['read'])] })
    const result = authorize({ doc, webId: alice, method: 'GET', path: '/alice/profile.ttl' })
    expect(result).toEqual({
      allowed: true,
      required: { target: 'read' },
      granted: ['read'],
      ownerOverride: false
    })
  })
})

describe('authorize PUT replacing an existing resource', () => {
  it('requires only write on the target, not any container grant', () => {
    const doc = makeDoc(scopes, {
      rs_alice_def: [webidGrant(alice, ['write'])],
      rs_alice_self: []
    })
    const result = authorize({
      doc,
      webId: alice,
      method: 'PUT',
      path: '/alice/profile.ttl',
      exists: true
    })
    expect(result).toEqual({
      allowed: true,
      required: { target: 'write' },
      granted: ['write'],
      ownerOverride: false
    })
  })
})

describe('authorize PUT creating a resource', () => {
  function docWith(target: Rule[], container: Rule[]): PolicyDoc {
    return makeDoc(scopes, { rs_alice_def: target, rs_alice_self: container })
  }

  const required = { target: 'write', container: 'append' } as const

  it('denies when the target grants write but the container lacks append', () => {
    const doc = docWith([webidGrant(alice, ['write'])], [])
    const result = authorize({
      doc,
      webId: alice,
      method: 'PUT',
      path: '/alice/profile.ttl',
      exists: false
    })
    expect(result.allowed).toBe(false)
    expect(result.required).toEqual(required)
  })

  it('allows when the target grants write and the container grants append', () => {
    const doc = docWith([webidGrant(alice, ['write'])], [webidGrant(alice, ['append'])])
    const result = authorize({
      doc,
      webId: alice,
      method: 'PUT',
      path: '/alice/profile.ttl',
      exists: false
    })
    expect(result.allowed).toBe(true)
    expect(result.required).toEqual(required)
  })

  it('allows when the container grants write, since append is a subclass of write', () => {
    const doc = docWith([webidGrant(alice, ['write'])], [webidGrant(alice, ['write'])])
    const result = authorize({
      doc,
      webId: alice,
      method: 'PUT',
      path: '/alice/profile.ttl',
      exists: false
    })
    expect(result.allowed).toBe(true)
  })

  it('denies when the target only grants append', () => {
    const doc = docWith([webidGrant(alice, ['append'])], [webidGrant(alice, ['append'])])
    const result = authorize({
      doc,
      webId: alice,
      method: 'PUT',
      path: '/alice/profile.ttl',
      exists: false
    })
    expect(result.allowed).toBe(false)
    expect(result.granted).toEqual(['append'])
  })

  it('uses an explicit containerPath instead of the derived parent', () => {
    const doc = makeDoc(scopes, {
      rs_alice_def: [webidGrant(alice, ['write'])],
      rs_alice_self: [],
      rs_shared_self: [webidGrant(alice, ['append'])]
    })
    const result = authorize({
      doc,
      webId: alice,
      method: 'PUT',
      path: '/alice/profile.ttl',
      containerPath: '/shared/',
      exists: false
    })
    expect(result.allowed).toBe(true)
  })
})

describe('authorize PATCH', () => {
  it('requires append for an insert-only PATCH and a write grant satisfies it', () => {
    const doc = makeDoc(scopes, { rs_alice_def: [webidGrant(alice, ['write'])] })
    const result = authorize({
      doc,
      webId: alice,
      method: 'PATCH',
      path: '/alice/profile.ttl',
      insertOnly: true
    })
    expect(result).toEqual({
      allowed: true,
      required: { target: 'append' },
      granted: ['write'],
      ownerOverride: false
    })
  })

  it('denies an insert-only PATCH without an append or write grant', () => {
    const doc = makeDoc(scopes, { rs_alice_def: [webidGrant(alice, ['read'])] })
    const result = authorize({
      doc,
      webId: alice,
      method: 'PATCH',
      path: '/alice/profile.ttl',
      insertOnly: true
    })
    expect(result.allowed).toBe(false)
    expect(result.required).toEqual({ target: 'append' })
  })

  it('requires write for a general PATCH and an append grant does not satisfy it', () => {
    const doc = makeDoc(scopes, { rs_alice_def: [webidGrant(alice, ['append'])] })
    const result = authorize({ doc, webId: alice, method: 'PATCH', path: '/alice/profile.ttl' })
    expect(result.allowed).toBe(false)
    expect(result.required).toEqual({ target: 'write' })
  })

  it('allows a general PATCH with a write grant', () => {
    const doc = makeDoc(scopes, { rs_alice_def: [webidGrant(alice, ['write'])] })
    const result = authorize({ doc, webId: alice, method: 'PATCH', path: '/alice/profile.ttl' })
    expect(result.allowed).toBe(true)
  })
})

describe('authorize POST', () => {
  it('denies without append or write on the container', () => {
    const doc = makeDoc(scopes, { rs_alice_self: [webidGrant(alice, ['read'])] })
    const result = authorize({ doc, webId: alice, method: 'POST', path: '/alice/' })
    expect(result.allowed).toBe(false)
    expect(result.required).toEqual({ target: 'append' })
  })

  it('allows with append on the container', () => {
    const doc = makeDoc(scopes, { rs_alice_self: [webidGrant(alice, ['append'])] })
    const result = authorize({ doc, webId: alice, method: 'POST', path: '/alice/' })
    expect(result.allowed).toBe(true)
  })

  it('allows with write on the container', () => {
    const doc = makeDoc(scopes, { rs_alice_self: [webidGrant(alice, ['write'])] })
    const result = authorize({ doc, webId: alice, method: 'POST', path: '/alice/' })
    expect(result.allowed).toBe(true)
  })
})

describe('authorize ACL resources', () => {
  it('requires control on the target', () => {
    const doc = makeDoc(scopes, { rs_alice_def: [webidGrant(alice, ['read', 'write'])] })
    const result = authorize({
      doc,
      webId: alice,
      method: 'PUT',
      path: '/alice/profile.ttl',
      isAcl: true
    })
    expect(result.allowed).toBe(false)
    expect(result.required).toEqual({ target: 'control' })
  })

  it('allows with control on the target', () => {
    const doc = makeDoc(scopes, { rs_alice_def: [webidGrant(alice, ['control'])] })
    const result = authorize({
      doc,
      webId: alice,
      method: 'PUT',
      path: '/alice/profile.ttl',
      isAcl: true
    })
    expect(result.allowed).toBe(true)
  })
})

describe('owner override', () => {
  const empty = makeDoc(scopes, {})

  it('grants an owner full modes on an ACL even with an empty ruleset', () => {
    const result = authorize({
      doc: empty,
      webId: owner,
      method: 'PUT',
      path: '/alice/profile.ttl',
      isAcl: true,
      ownerWebIds: [owner]
    })
    expect(result).toEqual({
      allowed: true,
      required: { target: 'control' },
      granted: ['append', 'control', 'read', 'write'],
      ownerOverride: true
    })
  })

  it('does not grant a non-owner', () => {
    const result = authorize({
      doc: empty,
      webId: alice,
      method: 'PUT',
      path: '/alice/profile.ttl',
      isAcl: true,
      ownerWebIds: [owner]
    })
    expect(result).toEqual({
      allowed: false,
      required: { target: 'control' },
      granted: [],
      ownerOverride: false
    })
  })

  it('does not apply the override when isAcl is false', () => {
    const result = authorize({
      doc: empty,
      webId: owner,
      method: 'PUT',
      path: '/alice/profile.ttl',
      exists: true,
      ownerWebIds: [owner]
    })
    expect(result.allowed).toBe(false)
    expect(result.ownerOverride).toBe(false)
  })
})
