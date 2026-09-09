import { Parser, Writer, Store, DataFactory } from 'n3'
import type { Quad } from '@rdfjs/types'
import type { Commit } from './github.js'

export class ChangelogValidationError extends Error {
  readonly status = 422
  constructor(message: string) {
    super(message)
    this.name = 'ChangelogValidationError'
  }
}

export interface ExtractedCreateActivity {
  /** The blank-node subject of the activity being created. */
  blankNode: string
  /** All quads whose subject equals `blankNode`, excluding any `rdfs:label` triples. */
  activityQuads: Quad[]
  /** The commit message, taken from the activity's `rdfs:label` literal. */
  message: string
}

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
const AS_CREATE = 'https://www.w3.org/ns/activitystreams#Create'
const AS_OBJECT = 'https://www.w3.org/ns/activitystreams#object'
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label'
const PROV_ACTIVITY = 'http://www.w3.org/ns/prov#Activity'
const PROV_GENERATED = 'http://www.w3.org/ns/prov#generated'
const PROV_USED = 'http://www.w3.org/ns/prov#used'
const PROV_ENDED = 'http://www.w3.org/ns/prov#endedAtTime'
const XSD_DATE_TIME = 'http://www.w3.org/2001/XMLSchema#dateTime'

/**
 * Parses a Turtle POST body for the changelog publish endpoint.
 *
 * Body shape (minimal):
 *   @prefix as: <https://www.w3.org/ns/activitystreams#>.
 *   <#create> a as:Create ; as:object _:b1 .
 *   _:b1 a prov:Activity ; rdfs:label "Initial save" .
 *
 * Throws ChangelogValidationError (status 422) on:
 *  - malformed Turtle
 *  - no `as:Create` subject
 *  - no `as:object` pointer on the Create subject
 *  - missing `rdfs:label` on the activity blank node
 */
export function extractCreateActivity(body: string): ExtractedCreateActivity {
  const baseIri = 'http://localhost/'
  const parser = new Parser({ format: 'text/turtle', baseIRI: baseIri })

  let quads: Quad[]
  try {
    quads = parser.parse(body)
  } catch (e) {
    throw new ChangelogValidationError(
      `Invalid Turtle body: ${(e as Error).message}`,
    )
  }

  const defaultGraph = DataFactory.defaultGraph()

  let createSubjectValue: string | null = null
  for (const q of quads) {
    if (
      q.graph.equals(defaultGraph) &&
      q.predicate.value === RDF_TYPE &&
      q.object.termType === 'NamedNode' &&
      q.object.value === AS_CREATE &&
      (q.subject.termType === 'BlankNode' || q.subject.termType === 'NamedNode')
    ) {
      createSubjectValue = q.subject.value
      break
    }
  }
  if (createSubjectValue === null) {
    throw new ChangelogValidationError('No as:Create activity in body.')
  }

  let activitySubjectValue: string | null = null
  for (const q of quads) {
    if (
      q.graph.equals(defaultGraph) &&
      q.subject.value === createSubjectValue &&
      q.predicate.value === AS_OBJECT &&
      (q.object.termType === 'BlankNode' || q.object.termType === 'NamedNode')
    ) {
      activitySubjectValue = q.object.value
      break
    }
  }
  if (activitySubjectValue === null) {
    throw new ChangelogValidationError('as:Create has no as:object pointer.')
  }

  const activityQuads: Quad[] = []
  let message: string | null = null
  for (const q of quads) {
    if (!q.graph.equals(defaultGraph)) continue
    if (q.subject.value !== activitySubjectValue) continue
    if (q.predicate.value === RDFS_LABEL) {
      if (message === null && q.object.termType === 'Literal') {
        message = q.object.value
      }
      continue
    }
    activityQuads.push(q)
  }

  if (message === null) {
    throw new ChangelogValidationError(
      'Commit message (rdfs:label) is required on the activity.',
    )
  }

  return {
    blankNode: activitySubjectValue,
    activityQuads,
    message,
  }
}

export interface AppendCurrentClientTriplesOptions {
  /** The existing shard content as a UTF-8 string. May be empty. */
  existing: string
  /** The activity's client triples (already filtered to exclude rdfs:label by extractCreateActivity). */
  activityQuads: Quad[]
  /** The blank-node subject from extractCreateActivity that should be rewritten to `<#current>`. */
  blankNode: string
}

export interface AppendedShard {
  /** The new shard content as a UTF-8 string (Turtle). */
  content: string
  /** Whether anything was actually appended (false when activityQuads is empty). */
  appended: boolean
}

/**
 * Reads `existing` (Turtle, may be empty), substitutes the activity's
 * blank-node subject for `<#current>` in `activityQuads`, appends those
 * quads to the parsed store, and returns the serialized Turtle.
 *
 * If `activityQuads` is empty, returns `existing` unchanged with appended=false.
 */
export async function appendCurrentClientTriples(
  options: AppendCurrentClientTriplesOptions,
): Promise<AppendedShard> {
  const { existing, activityQuads } = options

  if (activityQuads.length === 0) {
    return Promise.resolve({ content: existing, appended: false })
  }

  const baseIri = 'http://localhost/'
  const currentSubject = DataFactory.namedNode(`${baseIri}#current`)

  let existingQuads: Quad[]
  try {
    const parser = new Parser({ format: 'text/turtle', baseIRI: baseIri })
    existingQuads = parser.parse(existing)
  } catch (e) {
    throw new ChangelogValidationError(
      `Invalid existing shard: ${(e as Error).message}`,
    )
  }

  const store = new Store(existingQuads)
  for (const q of activityQuads) {
    store.addQuad(
      DataFactory.quad(currentSubject, q.predicate, q.object, q.graph),
    )
  }

  const writer = new Writer({ format: 'text/turtle', prefixes: {} })
  writer.addQuads([...store])

  const content = await new Promise<string>((resolve, reject) => {
    writer.end((err, result) => (err ? reject(err) : resolve(result)))
  })

  return { content, appended: true }
}

export interface SynthesizeOptions {
  /** The commit that produced this activity. */
  commit: Commit
  /** The canonical IRI of the changelog month resource, e.g.
   * 'https://example.com/foo/history/changelog/2024/03'. No trailing slash. */
  monthUrl: string
  /** The public URL of the page, e.g. 'https://example.com/foo'. No trailing slash.
   * Used for `prov:generated` / `prov:used` (page-state relationships). */
  pageUrl: string
  /** The short SHA of the predecessor commit, or null if this is the first commit ever. */
  prevShortSha: string | null
}

export interface SynthesizeResult {
  /** The IRI of the activity, a local fragment of the month resource: `<monthUrl>#<shortSha>`. */
  subject: string
  /** The synthesized server-managed triples. */
  quads: Quad[]
}

/**
 * Synthesizes the server-managed triples for one activity from commit
 * metadata. The activity's subject is `<monthUrl>#<shortSha>` (a local
 * fragment of the changelog month resource, not the page URL).
 * The synthesized triples are:
 *   - rdf:type prov:Activity
 *   - prov:generated <pageUrl>#<shortSha>
 *   - prov:used <pageUrl>#<prevShortSha>  (omitted when prevShortSha is null)
 *   - prov:endedAtTime "<commit.date>"^^xsd:dateTime
 *   - rdfs:label "<commit.message>"
 *
 * `prov:generated` / `prov:used` describe the page-state relationship
 * (the entity the activity produced / consumed), so they keep `pageUrl`.
 *
 * The `shortSha` is derived by slicing `commit.sha` to its first 7
 * characters (matching the existing history-route convention).
 */
export function synthesizeActivityTriples(
  options: SynthesizeOptions,
): SynthesizeResult {
  const { commit, monthUrl, pageUrl, prevShortSha } = options
  const shortSha = commit.sha.slice(0, 7)
  const subject = `${monthUrl}#${shortSha}`
  const subjectNode = DataFactory.namedNode(subject)

  const quads: Quad[] = [
    DataFactory.quad(
      subjectNode,
      DataFactory.namedNode(RDF_TYPE),
      DataFactory.namedNode(PROV_ACTIVITY),
    ),
    DataFactory.quad(
      subjectNode,
      DataFactory.namedNode(PROV_GENERATED),
      DataFactory.namedNode(`${pageUrl}#${shortSha}`),
    ),
  ]

  if (prevShortSha !== null) {
    quads.push(
      DataFactory.quad(
        subjectNode,
        DataFactory.namedNode(PROV_USED),
        DataFactory.namedNode(`${pageUrl}#${prevShortSha}`),
      ),
    )
  }

  quads.push(
    DataFactory.quad(
      subjectNode,
      DataFactory.namedNode(PROV_ENDED),
      DataFactory.literal(commit.date, DataFactory.namedNode(XSD_DATE_TIME)),
    ),
    DataFactory.quad(
      subjectNode,
      DataFactory.namedNode(RDFS_LABEL),
      DataFactory.literal(commit.message),
    ),
  )

  return { subject, quads }
}
