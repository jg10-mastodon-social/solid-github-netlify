import { describe, it, expect } from 'vitest'
import { DataFactory, Parser } from 'n3'
import type { Quad } from '@rdfjs/types'
import type { Commit } from '../../src/github.js'
import {
  extractCreateActivity,
  appendCurrentClientTriples,
  synthesizeActivityTriples,
  ChangelogValidationError,
} from '../../src/changelog.js'

const BASE_IRI = 'http://localhost/'
const EX = 'http://example.org/'
const B1 = `${BASE_IRI}#b1`
const CURRENT_NODE = `${BASE_IRI}#current`

function makeQuad(
  subjectIri: string,
  predicateIri: string,
  objectValue: string,
  literal = true,
): Quad {
  return DataFactory.quad(
    DataFactory.namedNode(subjectIri),
    DataFactory.namedNode(predicateIri),
    literal ? DataFactory.literal(objectValue) : DataFactory.namedNode(objectValue),
  )
}

function parseShard(content: string): Quad[] {
  return new Parser({ format: 'text/turtle', baseIRI: BASE_IRI }).parse(content)
}

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

describe('appendCurrentClientTriples', () => {
  it('appends a single activity quad to an empty shard, rewriting the subject to <#current>', async () => {
    const result = await appendCurrentClientTriples({
      existing: '',
      activityQuads: [makeQuad(B1, `${EX}custom`, 'foo')],
      blankNode: B1,
    })

    expect(result.appended).toBe(true)
    const quads = parseShard(result.content)
    expect(quads).toHaveLength(1)
    expect(quads[0]!.subject.value).toBe(CURRENT_NODE)
    expect(quads[0]!.subject.value).not.toBe(B1)
    expect(quads[0]!.predicate.value).toBe(`${EX}custom`)
    expect(quads[0]!.object.value).toBe('foo')
  })

  it('appends to a non-empty shard preserving both old and new triples', async () => {
    const result = await appendCurrentClientTriples({
      existing: `<#existing> <${EX}foo> "bar" .`,
      activityQuads: [makeQuad(B1, `${EX}new`, 'baz')],
      blankNode: B1,
    })

    expect(result.appended).toBe(true)
    const quads = parseShard(result.content)
    expect(quads).toHaveLength(2)
    const bySubj = new Map(quads.map((q) => [q.subject.value, q]))
    expect(bySubj.has(`${BASE_IRI}#existing`)).toBe(true)
    expect(bySubj.has(CURRENT_NODE)).toBe(true)
    expect(bySubj.get(`${BASE_IRI}#existing`)!.object.value).toBe('bar')
    expect(bySubj.get(CURRENT_NODE)!.object.value).toBe('baz')
  })

  it('returns existing unchanged with appended=false when activityQuads is empty', async () => {
    const existing = `<#existing> <${EX}foo> "bar" .`
    const result = await appendCurrentClientTriples({
      existing,
      activityQuads: [],
      blankNode: B1,
    })

    expect(result.appended).toBe(false)
    expect(result.content).toBe(existing)
  })

  it('appends multiple activity quads all with <#current> subject', async () => {
    const activityQuads = [
      makeQuad(B1, `${EX}foo`, '1'),
      makeQuad(B1, `${EX}bar`, '2'),
      makeQuad(B1, `${EX}baz`, '3'),
    ]
    const result = await appendCurrentClientTriples({
      existing: '',
      activityQuads,
      blankNode: B1,
    })

    expect(result.appended).toBe(true)
    const quads = parseShard(result.content)
    expect(quads).toHaveLength(3)
    for (const q of quads) {
      expect(q.subject.value).toBe(CURRENT_NODE)
      expect(q.subject.value).not.toBe(B1)
    }
    const values = quads.map((q) => q.object.value).sort()
    expect(values).toEqual(['1', '2', '3'])
  })

  it('handles the case where the subject is already <#current> (no-op rewrite)', async () => {
    const result = await appendCurrentClientTriples({
      existing: '',
      activityQuads: [makeQuad(CURRENT_NODE, `${EX}foo`, 'bar')],
      blankNode: CURRENT_NODE,
    })

    expect(result.appended).toBe(true)
    const quads = parseShard(result.content)
    expect(quads).toHaveLength(1)
    expect(quads[0]!.subject.value).toBe(CURRENT_NODE)
    expect(quads[0]!.predicate.value).toBe(`${EX}foo`)
    expect(quads[0]!.object.value).toBe('bar')
  })

  it('throws ChangelogValidationError with "Invalid existing shard" on malformed existing', async () => {
    const activityQuads = [makeQuad(B1, `${EX}custom`, 'foo')]
    const opts = {
      existing: '<<not turtle',
      activityQuads,
      blankNode: B1,
    }
    await expect(appendCurrentClientTriples(opts)).rejects.toThrow(
      ChangelogValidationError,
    )
    await expect(appendCurrentClientTriples(opts)).rejects.toThrow(
      /Invalid existing shard/,
    )
  })

  it('round-trips: appended content parses back to the expected quad', async () => {
    const result = await appendCurrentClientTriples({
      existing: '',
      activityQuads: [makeQuad(B1, `${EX}custom`, 'foo')],
      blankNode: B1,
    })

    expect(result.appended).toBe(true)
    const reparsed = parseShard(result.content)
    expect(reparsed).toHaveLength(1)
    const q = reparsed[0]!
    expect(q.subject.value).toBe(CURRENT_NODE)
    expect(q.predicate.value).toBe(`${EX}custom`)
    expect(q.object.value).toBe('foo')
  })
})

const PROV_ACTIVITY = 'http://www.w3.org/ns/prov#Activity'
const PROV_GENERATED = 'http://www.w3.org/ns/prov#generated'
const PROV_USED = 'http://www.w3.org/ns/prov#used'
const PROV_ENDED = 'http://www.w3.org/ns/prov#endedAtTime'
const XSD_DATE_TIME = 'http://www.w3.org/2001/XMLSchema#dateTime'
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label'

function findQuad(quads: Quad[], predicate: string): Quad | undefined {
  return quads.find((q) => q.predicate.value === predicate)
}

describe('synthesizeActivityTriples', () => {
  it('happy path with predecessor: emits subject, type, generated, used, endedAtTime, label', () => {
    const commit: Commit = {
      sha: 'abc1234567890deadbeefdeadbeefdeadbeef0000',
      message: 'Initial save',
      date: '2024-03-15T10:30:00Z',
      authorName: 'Alice',
      authorEmail: 'alice@example.com',
      htmlUrl: 'https://github.com/foo/bar/commit/abc1234',
    }
    const result = synthesizeActivityTriples({
      commit,
      monthUrl: 'https://example.com/foo/history/changelog/2024/03',
      pageUrl: 'https://example.com/foo',
      prevShortSha: 'def5678',
    })

    expect(result.subject).toBe('https://example.com/foo/history/changelog/2024/03#abc1234')
    expect(result.quads).toHaveLength(5)

    const typeQ = findQuad(result.quads, 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type')
    expect(typeQ).toBeDefined()
    expect(typeQ!.subject.value).toBe(result.subject)
    expect(typeQ!.object.termType).toBe('NamedNode')
    expect(typeQ!.object.value).toBe(PROV_ACTIVITY)

    const generatedQ = findQuad(result.quads, PROV_GENERATED)
    expect(generatedQ).toBeDefined()
    expect(generatedQ!.subject.value).toBe(result.subject)
    expect(generatedQ!.object.termType).toBe('NamedNode')
    expect(generatedQ!.object.value).toBe('https://example.com/foo/history/abc1234')

    const usedQ = findQuad(result.quads, PROV_USED)
    expect(usedQ).toBeDefined()
    expect(usedQ!.subject.value).toBe(result.subject)
    expect(usedQ!.object.termType).toBe('NamedNode')
    expect(usedQ!.object.value).toBe('https://example.com/foo/history/def5678')

    const endedQ = findQuad(result.quads, PROV_ENDED)
    expect(endedQ).toBeDefined()
    expect(endedQ!.subject.value).toBe(result.subject)
    const endedObj = endedQ!.object
    expect(endedObj.termType).toBe('Literal')
    if (endedObj.termType !== 'Literal') throw new Error('not literal')
    expect(endedObj.value).toBe('2024-03-15T10:30:00Z')
    expect(endedObj.datatype.value).toBe(XSD_DATE_TIME)

    const labelQ = findQuad(result.quads, RDFS_LABEL)
    expect(labelQ).toBeDefined()
    expect(labelQ!.subject.value).toBe(result.subject)
    expect(labelQ!.object.termType).toBe('Literal')
    expect(labelQ!.object.value).toBe('Initial save')
  })

  it('first commit (no predecessor): omits prov:used', () => {
    const commit: Commit = {
      sha: 'abc1234567890deadbeefdeadbeefdeadbeef0000',
      message: 'First commit',
      date: '2024-03-15T10:30:00Z',
      authorName: 'Alice',
      authorEmail: 'alice@example.com',
      htmlUrl: 'https://github.com/foo/bar/commit/abc1234',
    }
    const result = synthesizeActivityTriples({
      commit,
      monthUrl: 'https://example.com/foo/history/changelog/2024/03',
      pageUrl: 'https://example.com/foo',
      prevShortSha: null,
    })

    expect(result.subject).toBe('https://example.com/foo/history/changelog/2024/03#abc1234')
    expect(result.quads).toHaveLength(4)
    expect(findQuad(result.quads, PROV_USED)).toBeUndefined()
  })

  it('derives shortSha as the first 7 chars of commit.sha', () => {
    const commit: Commit = {
      sha: 'abcdefghijklmnopqrstuvwxyz0123456789abcd',
      message: 'msg',
      date: '2024-01-01T00:00:00Z',
      authorName: 'Alice',
      authorEmail: 'alice@example.com',
      htmlUrl: 'https://github.com/foo/bar/commit/abcdefg',
    }
    const result = synthesizeActivityTriples({
      commit,
      monthUrl: 'https://example.com/foo/history/changelog/2024/03',
      pageUrl: 'https://example.com/foo',
      prevShortSha: null,
    })

    expect(result.subject).toBe('https://example.com/foo/history/changelog/2024/03#abcdefg')
    expect(result.subject.endsWith('#abcdefg')).toBe(true)
  })

  it('uses the provided monthUrl as the activity subject (local fragment of the month)', () => {
    const commit: Commit = {
      sha: 'abc1234567890deadbeefdeadbeefdeadbeef0000',
      message: 'msg',
      date: '2024-01-01T00:00:00Z',
      authorName: 'Alice',
      authorEmail: 'alice@example.com',
      htmlUrl: 'https://github.com/foo/bar/commit/abc1234',
    }
    const result = synthesizeActivityTriples({
      commit,
      monthUrl: 'https://other.org/bar/history/changelog/2025/06',
      pageUrl: 'https://other.org/bar',
      prevShortSha: null,
    })

    expect(result.subject.startsWith('https://other.org/bar/history/changelog/2025/06#')).toBe(true)
    expect(result.subject).toBe('https://other.org/bar/history/changelog/2025/06#abc1234')
  })

  it('prov:generated points at the history folder for the commit, not at a page-relative fragment', () => {
    const commit: Commit = {
      sha: 'abc1234567890deadbeefdeadbeefdeadbeef0000',
      message: 'msg',
      date: '2024-01-01T00:00:00Z',
      authorName: 'Alice',
      authorEmail: 'alice@example.com',
      htmlUrl: 'https://github.com/foo/bar/commit/abc1234',
    }
    const result = synthesizeActivityTriples({
      commit,
      monthUrl: 'https://example.com/foo/history/changelog/2024/03',
      pageUrl: 'https://example.com/foo',
      prevShortSha: null,
    })

    const generatedQ = findQuad(result.quads, PROV_GENERATED)
    expect(generatedQ).toBeDefined()
    expect(generatedQ!.object.termType).toBe('NamedNode')
    expect(generatedQ!.object.value).toBe('https://example.com/foo/history/abc1234')
  })

  it('prov:used points at the history folder of the predecessor commit', () => {
    const commit: Commit = {
      sha: 'abc1234567890deadbeefdeadbeefdeadbeef0000',
      message: 'msg',
      date: '2024-01-01T00:00:00Z',
      authorName: 'Alice',
      authorEmail: 'alice@example.com',
      htmlUrl: 'https://github.com/foo/bar/commit/abc1234',
    }
    const result = synthesizeActivityTriples({
      commit,
      monthUrl: 'https://example.com/foo/history/changelog/2024/03',
      pageUrl: 'https://example.com/foo',
      prevShortSha: 'def5678',
    })

    const usedQ = findQuad(result.quads, PROV_USED)
    expect(usedQ).toBeDefined()
    expect(usedQ!.object.termType).toBe('NamedNode')
    expect(usedQ!.object.value).toBe('https://example.com/foo/history/def5678')
  })
})