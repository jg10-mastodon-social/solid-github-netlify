import { describe, it, expect } from 'vitest'
import type { Rule } from '../../../src/wac/evaluate.js'
import { rulesToTurtle, turtleToAcl } from '../../../src/wac/serialize.js'

function sortRules(rules: Rule[]): Rule[] {
  return [...rules].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
}

describe('rulesToTurtle', () => {
  it('serializes a WebID accessTo rule as an exact Turtle ACL document', () => {
    const turtle = rulesToTurtle({
      resourceUri: 'https://example.org/alice/note.ttl',
      accessTo: [
        {
          subject: { type: 'webid', id: 'https://alice.example/profile#me' },
          modes: ['read', 'write']
        }
      ],
      default: []
    })

    expect(turtle).toBe(
      [
        '@prefix acl: <http://www.w3.org/ns/auth/acl#>.',
        '@prefix foaf: <http://xmlns.com/foaf/0.1/>.',
        '@prefix vcard: <http://www.w3.org/2006/vcard/ns#>.',
        '',
        '<#authorization0> a acl:Authorization;',
        '    acl:accessTo <https://example.org/alice/note.ttl>;',
        '    acl:agent <https://alice.example/profile#me>;',
        '    acl:mode acl:Read, acl:Write.',
        ''
      ].join('\n')
    )
  })

  it('emits acl:accessTo and acl:default from the two independent lists', () => {
    const turtle = rulesToTurtle({
      resourceUri: 'https://example.org/alice/',
      accessTo: [{ subject: { class: 'public' }, modes: ['read'] }],
      default: [{ subject: { class: 'authenticated' }, modes: ['append'] }]
    })

    expect(turtle).toContain('<#authorization0> a acl:Authorization;')
    expect(turtle).toContain('acl:accessTo <https://example.org/alice/>;')
    expect(turtle).toContain('<#authorization1> a acl:Authorization;')
    expect(turtle).toContain('acl:default <https://example.org/alice/>;')
    expect(turtle).toContain('acl:agentClass foaf:Agent;')
    expect(turtle).toContain('acl:agentClass acl:AuthenticatedAgent;')
  })

  it('uses unique authorization ids across both predicate lists', () => {
    const turtle = rulesToTurtle({
      resourceUri: 'https://example.org/alice/',
      accessTo: [{ subject: { class: 'public' }, modes: ['read'] }],
      default: [{ subject: { class: 'public' }, modes: ['read'] }]
    })

    expect(turtle).toContain('<#authorization0> a acl:Authorization;')
    expect(turtle).toContain('<#authorization1> a acl:Authorization;')
    expect(turtle).not.toContain('<#authorization2>')
  })

  it('emits agentGroup and origin subjects', () => {
    const turtle = rulesToTurtle({
      resourceUri: 'https://example.org/note.ttl',
      accessTo: [
        { subject: { group: 'https://example.org/groups/editors#members' }, modes: ['read'] },
        { subject: { origin: 'https://app.example' }, modes: ['write'] }
      ],
      default: []
    })

    expect(turtle).toContain('acl:agentGroup <https://example.org/groups/editors#members>;')
    expect(turtle).toContain('acl:origin <https://app.example>;')
  })
})

describe('turtleToAcl', () => {
  it('round-trips distinct accessTo and default rules', () => {
    const accessTo: Rule[] = [
      {
        subject: { type: 'webid', id: 'https://alice.example/profile#me' },
        modes: ['read', 'write']
      },
      { subject: { class: 'public' }, modes: ['read'] }
    ]
    const defaultRules: Rule[] = [
      { subject: { class: 'authenticated' }, modes: ['append'] },
      { subject: { group: 'https://example.org/groups/editors#members' }, modes: ['read'] }
    ]

    const turtle = rulesToTurtle({
      resourceUri: 'https://example.org/alice/',
      accessTo,
      default: defaultRules
    })

    const parsed = turtleToAcl(turtle)
    expect(sortRules(parsed.accessTo)).toEqual(sortRules(accessTo))
    expect(sortRules(parsed.default)).toEqual(sortRules(defaultRules))
  })

  it('routes an authorization with only acl:default into default', () => {
    const turtle = [
      '@prefix acl: <http://www.w3.org/ns/auth/acl#>.',
      '@prefix foaf: <http://xmlns.com/foaf/0.1/>.',
      '',
      '<#auth> a acl:Authorization;',
      '    acl:default <https://example.org/alice/>;',
      '    acl:agentClass foaf:Agent;',
      '    acl:mode acl:Read.'
    ].join('\n')

    expect(turtleToAcl(turtle)).toEqual({
      accessTo: [],
      default: [{ subject: { class: 'public' }, modes: ['read'] }]
    })
  })

  it('contributes an authorization carrying both predicates to both lists', () => {
    const turtle = [
      '@prefix acl: <http://www.w3.org/ns/auth/acl#>.',
      '<#auth> a acl:Authorization;',
      '    acl:accessTo <https://example.org/note.ttl>;',
      '    acl:default <https://example.org/alice/>;',
      '    acl:agent <https://alice.example/profile#me>;',
      '    acl:mode acl:Read, acl:Write.'
    ].join('\n')

    const expected: Rule[] = [
      { subject: { type: 'webid', id: 'https://alice.example/profile#me' }, modes: ['read', 'write'] }
    ]
    expect(turtleToAcl(turtle)).toEqual({ accessTo: expected, default: expected })
  })

  it('parses a hand-written ACL with multiple subjects and modes', () => {
    const turtle = [
      '@prefix acl: <http://www.w3.org/ns/auth/acl#>.',
      '@prefix foaf: <http://xmlns.com/foaf/0.1/>.',
      '',
      '<#auth-public> a acl:Authorization;',
      '    acl:accessTo <https://example.org/note.ttl>;',
      '    acl:agentClass foaf:Agent;',
      '    acl:mode acl:Read.',
      '',
      '<#auth-alice> a acl:Authorization;',
      '    acl:accessTo <https://example.org/note.ttl>;',
      '    acl:agent <https://alice.example/profile#me>;',
      '    acl:mode acl:Read, acl:Write.',
      '',
      '<#auth-group> a acl:Authorization;',
      '    acl:accessTo <https://example.org/note.ttl>;',
      '    acl:agentGroup <https://example.org/groups/editors#members>;',
      '    acl:mode acl:Append, acl:Read.'
    ].join('\n')

    expect(sortRules(turtleToAcl(turtle).accessTo)).toEqual(
      sortRules([
        { subject: { class: 'public' }, modes: ['read'] },
        {
          subject: { type: 'webid', id: 'https://alice.example/profile#me' },
          modes: ['read', 'write']
        },
        {
          subject: { group: 'https://example.org/groups/editors#members' },
          modes: ['append', 'read']
        }
      ])
    )
  })

  it('recognises acl:AuthenticatedAgent', () => {
    const turtle = [
      '@prefix acl: <http://www.w3.org/ns/auth/acl#>.',
      '<#auth> a acl:Authorization;',
      '    acl:accessTo <https://example.org/note.ttl>;',
      '    acl:agentClass acl:AuthenticatedAgent;',
      '    acl:mode acl:Control.'
    ].join('\n')

    expect(turtleToAcl(turtle).accessTo).toEqual([
      { subject: { class: 'authenticated' }, modes: ['control'] }
    ])
  })

  it('ignores unrecognised predicates, modes and blank subjects', () => {
    const turtle = [
      '@prefix acl: <http://www.w3.org/ns/auth/acl#>.',
      '@prefix foaf: <http://xmlns.com/foaf/0.1/>.',
      '',
      '<#auth-ok> a acl:Authorization;',
      '    acl:accessTo <https://example.org/note.ttl>;',
      '    acl:agent <https://alice.example/profile#me>;',
      '    acl:mode acl:Read, acl:Bogus.',
      '',
      '<#auth-nosubject> a acl:Authorization;',
      '    acl:accessTo <https://example.org/note.ttl>;',
      '    acl:mode acl:Read.',
      '',
      '[] a acl:Authorization;',
      '    acl:accessTo <https://example.org/note.ttl>;',
      '    acl:agent <https://bob.example/profile#me>;',
      '    acl:mode acl:Read.',
      '',
      '<#unrelated> foaf:name "Not an authorization".'
    ].join('\n')

    expect(turtleToAcl(turtle).accessTo).toEqual([
      { subject: { type: 'webid', id: 'https://alice.example/profile#me' }, modes: ['read'] }
    ])
  })

  it('returns empty lists for turtle without authorizations', () => {
    expect(turtleToAcl('@prefix acl: <http://www.w3.org/ns/auth/acl#>.')).toEqual({
      accessTo: [],
      default: []
    })
  })
})
