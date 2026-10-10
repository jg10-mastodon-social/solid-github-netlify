import { createHash, randomUUID } from 'node:crypto'
import type { JsonStore } from './blobs.js'

export interface AuditEventInput {
  ts: string
  actor: string
  scope: string
  op: string
  before?: unknown
  after?: unknown
}

export interface AuditEvent extends AuditEventInput {
  prevHash: string | null
  hash: string
}

export const AUDIT_PREFIX = 'events/'

function canonicalValue(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  const parts = keys.map((key) => `${JSON.stringify(key)}:${canonicalValue(record[key])}`)
  return `{${parts.join(',')}}`
}

export function canonicalize(value: unknown): string {
  return canonicalValue(value)
}

export function computeHash(event: AuditEventInput, prevHash: string | null): string {
  const payload = `${prevHash ?? ''}${canonicalize(event)}`
  return createHash('sha256').update(payload).digest('hex')
}

export function eventKey(ts: string, id: string): string {
  return `${AUDIT_PREFIX}${ts}#${id}`
}

export async function appendEvent(
  store: JsonStore,
  event: AuditEventInput,
  options?: { id?: string }
): Promise<AuditEvent> {
  const entries = await store.list(AUDIT_PREFIX)
  const lastKey = entries
    .map((entry) => entry.key)
    .filter((key) => key.startsWith(AUDIT_PREFIX))
    .sort()
    .at(-1)

  let prevHash: string | null = null
  if (lastKey !== undefined) {
    const previous = await store.get<AuditEvent>(lastKey)
    prevHash = previous.data?.hash ?? null
  }

  const appended: AuditEvent = {
    ...event,
    prevHash,
    hash: computeHash(event, prevHash)
  }

  const id = options?.id ?? randomUUID()
  await store.set(eventKey(event.ts, id), appended, {
    onlyIfNew: true,
    metadata: { hash: appended.hash, prevHash: appended.prevHash }
  })

  return appended
}

export async function listEvents(store: JsonStore): Promise<AuditEvent[]> {
  const entries = await store.list(AUDIT_PREFIX)
  const keys = entries
    .map((entry) => entry.key)
    .filter((key) => key.startsWith(AUDIT_PREFIX))
    .sort()

  const events: AuditEvent[] = []
  for (const key of keys) {
    const result = await store.get<AuditEvent>(key)
    if (result.data !== null) events.push(result.data)
  }
  return events
}

export function verifyChain(events: AuditEvent[]): { valid: boolean; brokenAt: number | null } {
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i]
    const expectedPrev = i === 0 ? null : events[i - 1].hash
    if (event.prevHash !== expectedPrev) return { valid: false, brokenAt: i }

    const { prevHash, hash, ...fields } = event
    if (computeHash(fields, prevHash) !== hash) return { valid: false, brokenAt: i }
  }
  return { valid: true, brokenAt: null }
}
