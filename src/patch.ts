import { Parser, Writer, Store, DataFactory } from 'n3'
import type { Quad } from '@rdfjs/types'

export class PatchValidationError extends Error {
  readonly status = 422
  constructor(message: string) {
    super(message)
    this.name = 'PatchValidationError'
  }
}

export interface AppliedPatch {
  content: string
  contentType: 'text/turtle; charset=utf-8'
}

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
const SOLID_TERM = 'http://www.w3.org/ns/solid/terms#'
const SOLID_TYPE_PATCH = `${SOLID_TERM}InsertDeletePatch`
const SOLID_INSERTS = `${SOLID_TERM}inserts`
const SOLID_DELETES = `${SOLID_TERM}deletes`
const SOLID_WHERE = `${SOLID_TERM}where`

const PREFIX_DECL_RE = /(?:@prefix|PREFIX)\s+([A-Za-z][\w-]*)?:\s*<([^>]+)>\s*\./g

export interface ApplyInsertOnlyTurtlePatchOptions {
  body: Uint8Array
  existing: Uint8Array | null
}

export async function applyInsertOnlyTurtlePatch(
  opts: ApplyInsertOnlyTurtlePatchOptions,
): Promise<AppliedPatch> {
  const baseIri = 'http://localhost/'
  const patchText = text(opts.body)
  const patchPrefixes = extractPrefixes(patchText)

  const patchParser = new Parser({ format: 'N3', baseIRI: baseIri })
  const patchStore = new Store()
  let patchQuads: Quad[]
  try {
    patchQuads = patchParser.parse(patchText)
  } catch (e) {
    throw new PatchValidationError(
      `Invalid N3 patch body: ${(e as Error).message}`,
    )
  }
  patchStore.addQuads(patchQuads)

  const defaultGraph = DataFactory.defaultGraph()
  const patchSubjects: string[] = []
  for (const q of patchStore) {
    if (
      q.graph.equals(defaultGraph) &&
      q.predicate.value === RDF_TYPE &&
      q.object.termType === 'NamedNode' &&
      q.object.value === SOLID_TYPE_PATCH
    ) {
      if (q.subject.termType !== 'BlankNode' && q.subject.termType !== 'NamedNode') {
        throw new PatchValidationError(
          'Patch resource subject must be a BlankNode or NamedNode.',
        )
      }
      patchSubjects.push(q.subject.value)
    }
  }

  if (patchSubjects.length === 0) {
    throw new PatchValidationError(
      'Patch must contain exactly one resource of type solid:InsertDeletePatch; found 0.',
    )
  }
  if (patchSubjects.length > 1) {
    throw new PatchValidationError(
      `Patch must contain exactly one resource of type solid:InsertDeletePatch; found ${patchSubjects.length}.`,
    )
  }

  const patchSubjectValue = patchSubjects[0]!

  const findFormulaGraph = (
    predicateIri: string,
    localName: string,
  ): { present: boolean; nonEmpty: boolean; graphValue: string | null } => {
    let graphValue: string | null = null
    let count = 0
    for (const q of patchStore) {
      if (
        q.graph.equals(defaultGraph) &&
        q.subject.value === patchSubjectValue &&
        q.predicate.value === predicateIri
      ) {
        count++
        if (q.object.termType === 'BlankNode' || q.object.termType === 'NamedNode') {
          graphValue = q.object.value
        }
      }
    }
    if (count === 0) {
      return { present: false, nonEmpty: false, graphValue: null }
    }
    if (count > 1) {
      throw new PatchValidationError(
        `Patch resource must have at most one solid:${localName} predicate; found ${count}.`,
      )
    }
    if (graphValue === null) {
      throw new PatchValidationError(
        `solid:${localName} object must be a BlankNode or NamedNode.`,
      )
    }
    let nonEmpty = false
    for (const q of patchStore) {
      if (q.graph.termType !== 'DefaultGraph' && q.graph.value === graphValue) {
        nonEmpty = true
        break
      }
    }
    return { present: true, nonEmpty, graphValue }
  }

  const where = findFormulaGraph(SOLID_WHERE, 'where')
  const deletes = findFormulaGraph(SOLID_DELETES, 'deletes')
  const inserts = findFormulaGraph(SOLID_INSERTS, 'inserts')

  if (where.nonEmpty) {
    throw new PatchValidationError(
      'solid:where is not supported in this minimal patch handler.',
    )
  }
  if (deletes.nonEmpty) {
    throw new PatchValidationError(
      'solid:deletes is not supported in this minimal patch handler.',
    )
  }
  if (!inserts.present || inserts.graphValue === null) {
    throw new PatchValidationError(
      'solid:inserts must be present and non-empty.',
    )
  }

  const insertsGraphValue = inserts.graphValue!
  const insertQuads: Quad[] = []
  for (const q of patchStore) {
    if (
      q.graph.termType !== 'DefaultGraph' &&
      q.graph.value === insertsGraphValue
    ) {
      if (
        q.subject.termType !== 'NamedNode' ||
        q.predicate.termType !== 'NamedNode' ||
        (q.object.termType !== 'NamedNode' && q.object.termType !== 'Literal')
      ) {
        throw new PatchValidationError(
          'Insert triples must be ground (no blank nodes, no variables).',
        )
      }
      insertQuads.push(q)
    }
  }

  if (insertQuads.length === 0) {
    throw new PatchValidationError('solid:inserts formula must be non-empty.')
  }

  let existingStore: Store
  let existingPrefixes: Record<string, string> = {}
  if (opts.existing === null) {
    existingStore = new Store()
  } else {
    const existingText = text(opts.existing)
    if (existingText.trim().length === 0) {
      existingStore = new Store()
    } else {
      existingPrefixes = extractPrefixes(existingText)
      const existingParser = new Parser({
        format: 'text/turtle',
        baseIRI: baseIri,
      })
      let existingQuads: Quad[]
      try {
        existingQuads = existingParser.parse(existingText)
      } catch (e) {
        throw new PatchValidationError(
          `Existing document is not valid turtle: ${(e as Error).message}`,
        )
      }
      existingStore = new Store(existingQuads)
    }
  }

  for (const q of insertQuads) {
    existingStore.addQuad(
      DataFactory.quad(
        q.subject as ReturnType<typeof DataFactory.namedNode>,
        q.predicate as ReturnType<typeof DataFactory.namedNode>,
        q.object as ReturnType<typeof DataFactory.namedNode> | ReturnType<typeof DataFactory.literal>,
        DataFactory.defaultGraph(),
      ),
    )
  }

  const prefixes: Record<string, string> = {
    ...existingPrefixes,
    ...patchPrefixes,
  }
  const writer = new Writer({ format: 'text/turtle', prefixes })
  writer.addQuads([...existingStore])

  const content = await new Promise<string>((resolve, reject) => {
    writer.end((err, result) => (err ? reject(err) : resolve(result)))
  })

  return {
    content,
    contentType: 'text/turtle; charset=utf-8',
  }
}

function text(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes)
}

function extractPrefixes(input: string): Record<string, string> {
  const prefixes: Record<string, string> = {}
  const matches = input.matchAll(PREFIX_DECL_RE)
  for (const m of matches) {
    const name = m[1] ?? ''
    const iri = m[2]
    if (iri && !(name in prefixes)) {
      prefixes[name] = iri
    }
  }
  return prefixes
}
