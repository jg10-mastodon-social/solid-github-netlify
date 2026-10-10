import { Parser, Store, DataFactory } from 'n3'
import type { Quad, Term } from '@rdfjs/types'
import type { Mode, Rule, Subject } from './evaluate.js'

export interface AclDocumentOptions {
  resourceUri: string
  accessPredicate: 'accessTo' | 'default'
  rules: Rule[]
}

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
const ACL = 'http://www.w3.org/ns/auth/acl#'
const FOAF = 'http://xmlns.com/foaf/0.1/'

const ACL_AUTHORIZATION = `${ACL}Authorization`
const ACL_ACCESS_TO = `${ACL}accessTo`
const ACL_DEFAULT = `${ACL}default`
const ACL_MODE = `${ACL}mode`
const ACL_AGENT = `${ACL}agent`
const ACL_AGENT_CLASS = `${ACL}agentClass`
const ACL_AGENT_GROUP = `${ACL}agentGroup`
const ACL_ORIGIN = `${ACL}origin`
const ACL_AUTHENTICATED_AGENT = `${ACL}AuthenticatedAgent`
const FOAF_AGENT = `${FOAF}Agent`

const MODE_TO_IRI: Record<Mode, string> = {
  read: `${ACL}Read`,
  write: `${ACL}Write`,
  append: `${ACL}Append`,
  control: `${ACL}Control`
}

const IRI_TO_MODE: Record<string, Mode> = {
  [`${ACL}Read`]: 'read',
  [`${ACL}Write`]: 'write',
  [`${ACL}Append`]: 'append',
  [`${ACL}Control`]: 'control'
}

const MODE_ORDER: Mode[] = ['append', 'control', 'read', 'write']

function sortModes(modes: Iterable<Mode>): Mode[] {
  const set = new Set(modes)
  return MODE_ORDER.filter((mode) => set.has(mode))
}

function subjectLine(subject: Subject): string {
  if ('class' in subject) {
    return `acl:agentClass ${subject.class === 'public' ? 'foaf:Agent' : 'acl:AuthenticatedAgent'}`
  }
  if ('type' in subject) {
    return `acl:agent <${subject.id}>`
  }
  if ('group' in subject) {
    return `acl:agentGroup <${subject.group}>`
  }
  return `acl:origin <${subject.origin}>`
}

export function rulesToTurtle(options: AclDocumentOptions): string {
  const predicate = options.accessPredicate === 'default' ? 'acl:default' : 'acl:accessTo'
  const lines = [
    `@prefix acl: <${ACL}>.`,
    `@prefix foaf: <${FOAF}>.`,
    '@prefix vcard: <http://www.w3.org/2006/vcard/ns#>.',
    ''
  ]

  options.rules.forEach((rule, index) => {
    if (index > 0) lines.push('')
    const modes = sortModes(rule.modes).map((mode) => `acl:${MODE_TO_IRI[mode].slice(ACL.length)}`)
    lines.push(`<#authorization${index}> a acl:Authorization;`)
    lines.push(`    ${predicate} <${options.resourceUri}>;`)
    lines.push(`    ${subjectLine(rule.subject)};`)
    lines.push(`    acl:mode ${modes.join(', ')}.`)
  })

  return `${lines.join('\n')}\n`
}

function namedNodeValue(term: Term): string | null {
  return term.termType === 'NamedNode' ? term.value : null
}

function subjectFrom(predicate: string, object: Term): Subject | null {
  if (predicate === ACL_AGENT_CLASS) {
    const value = namedNodeValue(object)
    if (value === FOAF_AGENT) return { class: 'public' }
    if (value === ACL_AUTHENTICATED_AGENT) return { class: 'authenticated' }
    return null
  }
  const value = namedNodeValue(object)
  if (value === null) return null
  if (predicate === ACL_AGENT) return { type: 'webid', id: value }
  if (predicate === ACL_AGENT_GROUP) return { group: value }
  if (predicate === ACL_ORIGIN) return { origin: value }
  return null
}

const SUBJECT_PREDICATES = new Set([ACL_AGENT, ACL_AGENT_CLASS, ACL_AGENT_GROUP, ACL_ORIGIN])

export function turtleToRules(turtle: string): Rule[] {
  const parser = new Parser({ format: 'text/turtle', baseIRI: 'http://localhost/' })
  let quads: Quad[]
  try {
    quads = parser.parse(turtle)
  } catch {
    return []
  }
  const store = new Store(quads)

  const authorizationIds = new Set<string>()
  for (const quad of quads) {
    if (
      quad.predicate.value === RDF_TYPE &&
      quad.object.termType === 'NamedNode' &&
      quad.object.value === ACL_AUTHORIZATION &&
      quad.subject.termType === 'NamedNode'
    ) {
      authorizationIds.add(quad.subject.value)
    }
  }

  const rules: Rule[] = []
  for (const id of authorizationIds) {
    const subject = DataFactory.namedNode(id)
    const modes = new Set<Mode>()
    const subjects: Subject[] = []

    for (const quad of store.getQuads(subject, DataFactory.namedNode(ACL_MODE), null, null)) {
      const mode = IRI_TO_MODE[quad.object.value]
      if (mode !== undefined && quad.object.termType === 'NamedNode') modes.add(mode)
    }

    for (const predicate of SUBJECT_PREDICATES) {
      for (const quad of store.getQuads(subject, DataFactory.namedNode(predicate), null, null)) {
        const parsed = subjectFrom(predicate, quad.object)
        if (parsed !== null) subjects.push(parsed)
      }
    }

    if (subjects.length === 0) continue
    const sorted = sortModes(modes)
    for (const parsed of subjects) rules.push({ subject: parsed, modes: [...sorted] })
  }

  return rules
}
