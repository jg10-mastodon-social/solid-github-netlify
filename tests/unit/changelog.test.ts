import { describe, it, expect } from 'vitest'
import {
  extractCreateActivity,
  ChangelogValidationError,
} from '../../src/changelog.js'

describe('extractCreateActivity', () => {
  it('parses a minimal Create activity with one client triple', () => {
    const body = `@prefix as: <https://www.w3.org/ns/activitystreams#>.
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#>.
@prefix ex: <http://example.org/>.
<#create> a as:Create ; as:object _:b1 .
_:b1 rdfs:label "Initial save" ; ex:custom "foo" .
`
    const result = extractCreateActivity(body)

    expect(result.message).toBe('Initial save')
    expect(result.activityQuads).toHaveLength(1)
    const q = result.activityQuads[0]!
    expect(q.subject.termType).toBe('BlankNode')
    expect(q.subject.value).toBe(result.blankNode)
    expect(q.predicate.value).toBe('http://example.org/custom')
    expect(q.object.value).toBe('foo')
  })

  it('returns every client triple on the activity subject (excluding rdfs:label)', () => {
    const body = `@prefix as: <https://www.w3.org/ns/activitystreams#>.
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#>.
@prefix ex: <http://example.org/>.
<#create> a as:Create ; as:object _:b1 .
_:b1 rdfs:label "Two extras" ; ex:foo "1" ; ex:bar "2" .
`
    const result = extractCreateActivity(body)

    expect(result.activityQuads).toHaveLength(2)
    const predicates = result.activityQuads.map((q) => q.predicate.value).sort()
    expect(predicates).toEqual([
      'http://example.org/bar',
      'http://example.org/foo',
    ])
    for (const q of result.activityQuads) {
      expect(q.subject.value).toBe(result.blankNode)
      expect(q.subject.termType).toBe('BlankNode')
      expect(q.predicate.value).not.toBe(
        'http://www.w3.org/2000/01/rdf-schema#label',
      )
    }
  })

  it('throws ChangelogValidationError with rdfs:label in the message when the label is missing', () => {
    const body = `@prefix as: <https://www.w3.org/ns/activitystreams#>.
@prefix ex: <http://example.org/>.
<#create> a as:Create ; as:object _:b1 .
_:b1 ex:custom "foo" .
`
    expect(() => extractCreateActivity(body)).toThrow(ChangelogValidationError)
    expect(() => extractCreateActivity(body)).toThrow(/rdfs:label/)
  })

  it('throws ChangelogValidationError prefixed "Invalid Turtle body" on malformed input', () => {
    expect(() => extractCreateActivity('this is not valid turtle <<<')).toThrow(
      ChangelogValidationError,
    )
    expect(() => extractCreateActivity('this is not valid turtle <<<')).toThrow(
      /Invalid Turtle body/,
    )
  })

  it('throws ChangelogValidationError mentioning as:Create when no Create activity is present', () => {
    const body = `@prefix ex: <http://example.org/>.
<#something> ex:foo "bar" .
`
    expect(() => extractCreateActivity(body)).toThrow(ChangelogValidationError)
    expect(() => extractCreateActivity(body)).toThrow(/as:Create/)
  })

  it('throws ChangelogValidationError mentioning as:object when the Create activity has no object pointer', () => {
    const body = `@prefix as: <https://www.w3.org/ns/activitystreams#>.
<#create> a as:Create .
`
    expect(() => extractCreateActivity(body)).toThrow(ChangelogValidationError)
    expect(() => extractCreateActivity(body)).toThrow(/as:object/)
  })

  it('accepts a named-node activity subject (resolved against the base IRI)', () => {
    const body = `@prefix as: <https://www.w3.org/ns/activitystreams#>.
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#>.
@prefix ex: <http://example.org/>.
<#create> a as:Create ; as:object <#activity> .
<#activity> rdfs:label "Named" ; ex:custom "x" .
`
    const result = extractCreateActivity(body)

    expect(result.blankNode).toBe('http://localhost/#activity')
    expect(result.message).toBe('Named')
    expect(result.activityQuads).toHaveLength(1)
    expect(result.activityQuads[0]!.subject.value).toBe(
      'http://localhost/#activity',
    )
  })
})

describe('ChangelogValidationError', () => {
  it('has status 422', () => {
    const err = new ChangelogValidationError('boom')
    expect(err.status).toBe(422)
    expect(err.name).toBe('ChangelogValidationError')
    expect(err.message).toBe('boom')
  })
})