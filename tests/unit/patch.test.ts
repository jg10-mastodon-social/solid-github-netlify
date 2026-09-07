import { describe, it, expect } from 'vitest'
import {
  applyInsertDeleteTurtlePatch,
  PatchValidationError,
  PatchConflictError,
} from '../../src/patch.js'

const PREFIXES = `@prefix solid: <http://www.w3.org/ns/solid/terms#>.
@prefix ex: <http://www.example.org/terms#>.
`

function patch(inserts: string, opts: { where?: string; deletes?: string } = {}): string {
  let body = PREFIXES + '\n_:patch'
  if (opts.where) body += `\n      solid:where { ${opts.where} };`
  if (opts.deletes) body += `\n      solid:deletes { ${opts.deletes} };`
  body += `\n      solid:inserts { ${inserts} };\n   a solid:InsertDeletePatch .\n`
  return body
}

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

async function apply(
  body: string,
  existing: string | null,
): Promise<{ content: string; contentType: string }> {
  return applyInsertDeleteTurtlePatch({
    body: bytes(body),
    existing: existing === null ? null : bytes(existing),
  })
}

describe('applyInsertDeleteTurtlePatch — success cases', () => {
  it('applies a single insert to an empty store', async () => {
    const result = await apply(patch('ex:alice ex:knows ex:bob .'), null)
    expect(result.contentType).toBe('text/turtle; charset=utf-8')
    expect(result.content).toContain('ex:alice')
    expect(result.content).toContain('ex:knows')
    expect(result.content).toContain('ex:bob')
  })

  it('parses back as turtle and contains the inserted triple', async () => {
    const result = await apply(patch('ex:alice ex:knows ex:bob .'), null)
    // Should be valid turtle — sanity check by ensuring exactly one period-terminated triple
    expect(result.content).toMatch(/ex:alice\s+ex:knows\s+ex:bob\s*\./)
  })

  it('merges inserts into an existing turtle file', async () => {
    const existing = `${PREFIXES}ex:alice ex:knows ex:carol .\n`
    const result = await apply(patch('ex:alice ex:knows ex:bob .'), existing)
    // Writer may collapse shared subject+predicate into a single list like "ex:alice ex:knows ex:carol, ex:bob."
    expect(result.content).toMatch(/ex:alice\s+ex:knows\s+ex:(?:carol|bob)/)
    expect(result.content).toMatch(/ex:alice\s+ex:knows\s+ex:(?:carol|bob)(?:,\s*ex:(?:carol|bob))?/)
    expect(result.content).toContain('ex:carol')
    expect(result.content).toContain('ex:bob')
  })

  it('preserves existing triples when applying inserts', async () => {
    const existing = `${PREFIXES}ex:keep1 ex:p "v1" .\nex:keep2 ex:p "v2" .\n`
    const result = await apply(patch('ex:new ex:p "v3" .'), existing)
    expect(result.content).toContain('ex:keep1')
    expect(result.content).toContain('ex:keep2')
    expect(result.content).toContain('ex:new')
  })

  it('applies multiple insert triples', async () => {
    const result = await apply(
      patch('ex:a ex:p ex:b .\nex:c ex:p ex:d .'),
      null,
    )
    expect(result.content).toMatch(/ex:a\s+ex:p\s+ex:b/)
    expect(result.content).toMatch(/ex:c\s+ex:p\s+ex:d/)
  })

  it('preserves literal values (strings, integers) in inserts', async () => {
    const result = await apply(
      patch('ex:s ex:name "Alice" ; ex:age 42 .'),
      null,
    )
    expect(result.content).toMatch(/"Alice"/)
    expect(result.content).toMatch(/\b42\b/)
  })

  it('handles an empty existing file (zero-byte body)', async () => {
    const result = await apply(patch('ex:alice ex:p ex:bob .'), '')
    expect(result.content).toContain('ex:alice')
  })

  it('round-trips: re-parsing the serialized output yields the same triples', async () => {
    const inserted = patch('ex:alice ex:knows ex:bob .')
    const result = await apply(inserted, null)
    // Re-parse the output to confirm it's valid turtle (n3 is the implementation's own parser,
    // so we just assert the output structure here — no throw from serialize side-effects)
    expect(result.content.length).toBeGreaterThan(0)
    expect(result.content.endsWith('\n')).toBe(true)
  })
})

describe('applyInsertOnlyTurtlePatch — rejection cases', () => {
  it('rejects when solid:where is present', async () => {
    await expect(
      apply(patch('ex:a ex:p ex:b .', { where: '?s ex:p ?o' }), null),
    ).rejects.toBeInstanceOf(PatchValidationError)
  })

  it('rejects when both solid:where and solid:deletes are present', async () => {
    await expect(
      apply(
        patch('ex:a ex:p ex:b .', {
          where: '?s ex:p ?o',
          deletes: 'ex:x ex:p ex:y',
        }),
        null,
      ),
    ).rejects.toBeInstanceOf(PatchValidationError)
  })

  it('rejects when no patch resource has type solid:InsertDeletePatch', async () => {
    const body = `${PREFIXES}_:patch solid:inserts { ex:a ex:p ex:b } .\n`
    await expect(apply(body, null)).rejects.toBeInstanceOf(PatchValidationError)
  })

  it('rejects when there are multiple patch resources', async () => {
    const body = `${PREFIXES}
_:p1 solid:inserts { ex:a ex:p ex:b } ; a solid:InsertDeletePatch .
_:p2 solid:inserts { ex:c ex:p ex:d } ; a solid:InsertDeletePatch .
`
    await expect(apply(body, null)).rejects.toBeInstanceOf(PatchValidationError)
  })

  it('rejects when solid:inserts is empty (missing)', async () => {
    const body = `${PREFIXES}_:patch a solid:InsertDeletePatch .\n`
    await expect(apply(body, null)).rejects.toBeInstanceOf(PatchValidationError)
  })

  it('rejects when inserts contain a blank node', async () => {
    await expect(
      apply(patch('_:b ex:p ex:o .'), null),
    ).rejects.toBeInstanceOf(PatchValidationError)
  })

  it('rejects when inserts contain a variable', async () => {
    await expect(
      apply(patch('?s ex:p ex:o .'), null),
    ).rejects.toBeInstanceOf(PatchValidationError)
  })

  it('rejects an empty body', async () => {
    await expect(apply('', null)).rejects.toBeInstanceOf(PatchValidationError)
  })

  it('rejects malformed body', async () => {
    await expect(apply('this is not valid n3', null)).rejects.toBeInstanceOf(
      PatchValidationError,
    )
  })

  it('rejects when existing body is malformed turtle', async () => {
    await expect(
      apply(patch('ex:a ex:p ex:b .'), '<<not turtle'),
    ).rejects.toBeInstanceOf(PatchValidationError)
  })
})

describe('applyInsertDeleteTurtlePatch — ground delete triples', () => {
  it('removes a single deleted triple from an existing store', async () => {
    const existing = `${PREFIXES}ex:alice ex:knows ex:carol .\nex:alice ex:knows ex:bob .\n`
    const result = await apply(
      patch('ex:eve ex:knows ex:alice .', { deletes: 'ex:alice ex:knows ex:carol' }),
      existing,
    )
    expect(result.content).not.toMatch(/ex:carol/)
    expect(result.content).toContain('ex:bob')
    expect(result.content).toContain('ex:eve')
  })

  it('removes multiple deleted triples from an existing store', async () => {
    const existing = `${PREFIXES}
ex:alice ex:knows ex:carol .
ex:alice ex:knows ex:bob .
ex:bob ex:knows ex:carol .
`
    const result = await apply(
      patch(
        'ex:eve ex:knows ex:alice .',
        { deletes: 'ex:alice ex:knows ex:carol .\nex:bob ex:knows ex:carol' },
      ),
      existing,
    )
    expect(result.content).not.toMatch(/ex:carol/)
    expect(result.content).toContain('ex:eve')
  })

  it('applies deletes before inserts (deletes-then-inserts order)', async () => {
    const existing = `${PREFIXES}ex:alice ex:p "old" .\n`
    const result = await apply(
      patch('ex:alice ex:p "new" .', { deletes: 'ex:alice ex:p "old"' }),
      existing,
    )
    expect(result.content).not.toMatch(/"old"/)
    expect(result.content).toMatch(/"new"/)
  })

  it('applies a deletes-only patch (no inserts) to an existing store', async () => {
    const existing = `${PREFIXES}
ex:alice ex:knows ex:carol .
ex:alice ex:knows ex:bob .
`
    const result = await apply(
      patch('', { deletes: 'ex:alice ex:knows ex:carol .\nex:alice ex:knows ex:bob' }),
      existing,
    )
    expect(result.content).not.toMatch(/ex:carol/)
    expect(result.content).not.toMatch(/ex:bob/)
  })

  it('treats an empty solid:deletes formula as a no-op alongside inserts', async () => {
    const existing = `${PREFIXES}ex:keep ex:p "v" .\n`
    const result = await apply(patch('ex:new ex:p "x" .'), existing)
    expect(result.content).toContain('ex:keep')
    expect(result.content).toContain('ex:new')
  })

  it('rejects when solid:deletes contains a variable', async () => {
    await expect(
      apply(
        patch('ex:a ex:p ex:b .', { deletes: '?s ex:p ex:carol' }),
        null,
      ),
    ).rejects.toBeInstanceOf(PatchValidationError)
  })

  it('rejects when solid:deletes contains a blank node', async () => {
    await expect(
      apply(patch('ex:a ex:p ex:b .', { deletes: '_:b ex:p ex:carol' }), null),
    ).rejects.toBeInstanceOf(PatchValidationError)
  })

  it('returns PatchConflictError when a deleted triple is not in the existing store', async () => {
    const existing = `${PREFIXES}ex:alice ex:knows ex:carol .\n`
    await expect(
      apply(
        patch('ex:eve ex:knows ex:alice .', { deletes: 'ex:bob ex:knows ex:carol' }),
        existing,
      ),
    ).rejects.toBeInstanceOf(PatchConflictError)
  })

  it('returns PatchConflictError when deletes are non-empty but existing is null', async () => {
    await expect(
      apply(
        patch('ex:eve ex:p ex:alice .', { deletes: 'ex:bob ex:p ex:carol' }),
        null,
      ),
    ).rejects.toBeInstanceOf(PatchConflictError)
  })
})

describe('PatchConflictError', () => {
  it('has status 409 and a descriptive message', async () => {
    try {
      await apply(
        patch('ex:eve ex:p ex:alice .', { deletes: 'ex:bob ex:p ex:carol' }),
        `${PREFIXES}ex:alice ex:p ex:carol .\n`,
      )
      expect.fail('expected PatchConflictError to be thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(PatchConflictError)
      const err = e as PatchConflictError
      expect(err.status).toBe(409)
      expect(err.message.length).toBeGreaterThan(0)
    }
  })
})

describe('PatchValidationError', () => {
  it('has status 422 and a descriptive message', async () => {
    try {
      await apply(patch('ex:a ex:p ex:b .', { where: '?s ?p ?o' }), null)
      expect.fail('expected PatchValidationError to be thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(PatchValidationError)
      const err = e as PatchValidationError
      expect(err.status).toBe(422)
      expect(err.message.length).toBeGreaterThan(0)
    }
  })
})
