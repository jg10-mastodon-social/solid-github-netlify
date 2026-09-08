import { Parser, Writer, Store, DataFactory } from 'n3'
import type { Quad } from '@rdfjs/types'

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
