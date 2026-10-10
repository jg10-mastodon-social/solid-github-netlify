import { describe, it, expect } from 'vitest'
import type { Rule } from '../../../src/wac/evaluate.js'
import { rulesToTurtle, turtleToRules } from '../../../src/wac/serialize.js'

function sortRules(rules: Rule[]): Rule[] {
  return [...rules].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
}

describe('rulesToTurtle', () => {
  it('serializes a WebID rule as an exact Turtle ACL document', () => {
    const turtle = rulesToTurtle({
      resourceUri: 'https://example.org/alice/note.ttl',
      accessPredicate: 'accessTo',
      rules: [
        {
          subject: { type: 'webid', id: 'https://alice.example/profile#me' },
          modes: ['read', 'write']
        }
      ]
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

  it('emits acl:default and one authorization per rule', () => {
    const turtle = rulesToTurtle({
      resourceUri: 'https://example.org/alice/',
      accessPredicate: 'default',
      rules: [
        { subject: { class: 'public' }, modes: ['read'] },
        { subject: { class: 'authenticated' }, modes: ['append'] }
      ]
    })

    expect(turtle).toContain('<#authorization0> a acl:Authorization;')
    expect(turtle).toContain('<#authorization1> a acl:Authorization;')
    expect(turtle).toContain('acl:default <https://example.org/alice/>;')
    expect(turtle).toContain('acl:agentClass foaf:Agent;')
    expect(turtle).toContain('acl:agentClass acl:AuthenticatedAgent;')
    expect(turtle).not.toContain('acl:accessTo')
  })

  it('emits agentGroup and origin subjects', () => {
    const turtle = rulesToTurtle({
      resourceUri: 'https://example.org/note.ttl',
      accessPredicate: 'accessTo',
      rules: [
        { subject: { group: 'https://example.org/groups/editors#members' }, modes: ['read'] },
        { subject: { origin: 'https://app.example' }, modes: ['write'] }
      ]
    })

    expect(turtle).toContain('acl:agentGroup <https://example.org/groups/editors#members>;')
    expect(turtle).toContain('acl:origin <https://app.example>;')
  })
})

describe('turtleToRules', () => {
  it('round-trips representative rules through turtle', () => {
    const rules: Rule[] = [
      {
        subject: { type: 'webid', id: 'https://alice.example/profile#me' },
        modes: ['read', 'write']
      },
      { subject: { class: 'public' }, modes: ['read'] },
      { subject: { class: 'authenticated' }, modes: ['append', 'control'] },
      { subject: { group: 'https://example.org/groups/editors#members' }, modes: ['read'] },
      { subject: { origin: 'https://app.example' }, modes: ['write'] }
    ]

    const turtle = rulesToTurtle({
      resourceUri: 'https://example.org/alice/note.ttl',
      accessPredicate: 'accessTo',
      rules
    })

    expect(sortRules(turtleToRules(turtle))).toEqual(sortRules(rules))
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

    expect(sortRules(turtleToRules(turtle))).toEqual(
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
      '    acl:agentClass acl:AuthenticatedAgent;',
      '    acl:mode acl:Control.'
    ].join('\n')

    expect(turtleToRules(turtle)).toEqual([
      { subject: { class: 'authenticated' }, modes: ['control'] }
    ])
  })

  it('ignores unrecognised predicates, modes and blank subjects', () => {
    const turtle = [
      '@prefix acl: <http://www.w3.org/ns/auth/acl#>.',
      '@prefix foaf: <http://xmlns.com/foaf/0.1/>.',
      '',
      '<#auth-ok> a acl:Authorization;',
      '    acl:agent <https://alice.example/profile#me>;',
      '    acl:mode acl:Read, acl:Bogus.',
      '',
      '<#auth-nosubject> a acl:Authorization;',
      '    acl:mode acl:Read.',
      '',
      '[] a acl:Authorization;',
      '    acl:agent <https://bob.example/profile#me>;',
      '    acl:mode acl:Read.',
      '',
      '<#unrelated> foaf:name "Not an authorization".'
    ].join('\n')

    expect(turtleToRules(turtle)).toEqual([
      { subject: { type: 'webid', id: 'https://alice.example/profile#me' }, modes: ['read'] }
    ])
  })

  it('returns an empty array for turtle without authorizations', () => {
    expect(turtleToRules('@prefix acl: <http://www.w3.org/ns/auth/acl#>.')).toEqual([])
  })
})
