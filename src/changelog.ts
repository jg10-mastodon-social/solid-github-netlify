import { Parser, DataFactory } from 'n3'
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