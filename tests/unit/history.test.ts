import { describe, it, expect } from 'vitest'
import { parseHistoryPath } from '../../src/history.js'

describe('parseHistoryPath', () => {
  describe('root', () => {
    it('returns history_root for empty input', () => {
      expect(parseHistoryPath('')).toEqual({ kind: 'history_root' })
    })
  })

  describe('draft literal (must 404)', () => {
    it('returns null for the literal "draft" segment', () => {
      expect(parseHistoryPath('draft')).toBeNull()
    })
  })

  describe('year container', () => {
    it('parses a 4-digit year', () => {
      expect(parseHistoryPath('2026')).toEqual({ kind: 'year', year: 2026 })
    })

    it('parses the year 2014', () => {
      expect(parseHistoryPath('2014')).toEqual({ kind: 'year', year: 2014 })
    })

    it('parses the year 2009 (pre-2010 example)', () => {
      expect(parseHistoryPath('2009')).toEqual({ kind: 'year', year: 2009 })
    })

    it('rejects a 3-digit "year"', () => {
      expect(parseHistoryPath('999')).toBeNull()
    })

    it('rejects a 5-digit "year"', () => {
      expect(parseHistoryPath('10000')).toBeNull()
    })

    it('rejects a non-numeric 4-char segment', () => {
      expect(parseHistoryPath('abcd')).toBeNull()
    })
  })

  describe('month container', () => {
    it('parses YYYY/MM where MM is two digits', () => {
      expect(parseHistoryPath('2026/08')).toEqual({ kind: 'month', year: 2026, month: 8 })
    })

    it('parses single-digit months via zero-pad semantics: 2026/1 is not valid', () => {
      expect(parseHistoryPath('2026/1')).toBeNull()
    })

    it('parses YYYY/12', () => {
      expect(parseHistoryPath('2026/12')).toEqual({ kind: 'month', year: 2026, month: 12 })
    })

    it('rejects YYYY/00', () => {
      expect(parseHistoryPath('2026/00')).toBeNull()
    })

    it('rejects YYYY/13', () => {
      expect(parseHistoryPath('2026/13')).toBeNull()
    })
  })

  describe('commit folder (shortSha only)', () => {
    it('parses an 8-character hex shortSha', () => {
      expect(parseHistoryPath('abc12345')).toEqual({
        kind: 'commit_folder',
        shortSha: 'abc12345'
      })
    })

    it('parses a full 40-character SHA', () => {
      const sha = 'a'.repeat(40)
      expect(parseHistoryPath(sha)).toEqual({ kind: 'commit_folder', shortSha: sha })
    })

    it('parses a 7-character hex (minimum)', () => {
      expect(parseHistoryPath('abcdef0')).toEqual({
        kind: 'commit_folder',
        shortSha: 'abcdef0'
      })
    })

    it('rejects a 6-character hex (too short)', () => {
      expect(parseHistoryPath('abcdef')).toBeNull()
    })

    it('rejects a non-hex shortSha of valid length', () => {
      expect(parseHistoryPath('ghijklmn')).toBeNull()
    })

    it('rejects a SHA with invalid characters (mixed case is fine, but special chars are not)', () => {
      expect(parseHistoryPath('abc1234!')).toBeNull()
    })
  })

  describe('commit file (shortSha + doc)', () => {
    it('parses shortSha/foo.txt', () => {
      expect(parseHistoryPath('abc12345/foo.txt')).toEqual({
        kind: 'commit_file',
        shortSha: 'abc12345',
        doc: 'foo.txt'
      })
    })

    it('parses shortSha with multi-segment doc', () => {
      expect(parseHistoryPath('abc12345/sub/nested/file.md')).toEqual({
        kind: 'commit_file',
        shortSha: 'abc12345',
        doc: 'sub/nested/file.md'
      })
    })

    it('parses shortSha with single-char doc', () => {
      expect(parseHistoryPath('abc12345/a')).toEqual({
        kind: 'commit_file',
        shortSha: 'abc12345',
        doc: 'a'
      })
    })
  })

  describe('bucket-prefixed commit file (SHA-robust)', () => {
    it('parses YYYY/shortSha/doc with bucketPrefix="YYYY"', () => {
      expect(parseHistoryPath('2024/abc12345/foo.txt')).toEqual({
        kind: 'commit_file',
        shortSha: 'abc12345',
        doc: 'foo.txt',
        bucketPrefix: '2024'
      })
    })

    it('parses YYYY/MM/shortSha/doc with bucketPrefix="YYYY/MM"', () => {
      expect(parseHistoryPath('2026/08/abc12345/foo.txt')).toEqual({
        kind: 'commit_file',
        shortSha: 'abc12345',
        doc: 'foo.txt',
        bucketPrefix: '2026/08'
      })
    })

    it('parses YYYY/MM/shortSha with no doc (commit folder, bucket-prefixed)', () => {
      expect(parseHistoryPath('2026/08/abc12345')).toEqual({
        kind: 'commit_folder',
        shortSha: 'abc12345',
        bucketPrefix: '2026/08'
      })
    })

    it('parses YYYY/shortSha with no doc (commit folder, year-prefixed)', () => {
      expect(parseHistoryPath('2024/abc12345')).toEqual({
        kind: 'commit_folder',
        shortSha: 'abc12345',
        bucketPrefix: '2024'
      })
    })

    it('parses YYYY/MM/shortSha/sub/nested (multi-segment doc, bucket-prefixed)', () => {
      expect(parseHistoryPath('2026/08/abc12345/sub/nested/file.md')).toEqual({
        kind: 'commit_file',
        shortSha: 'abc12345',
        doc: 'sub/nested/file.md',
        bucketPrefix: '2026/08'
      })
    })
  })

  describe('malformed inputs', () => {
    it('rejects YYYY/foo (3rd segment is not a SHA and not a 2-digit month)', () => {
      expect(parseHistoryPath('2026/foo')).toBeNull()
    })

    it('rejects YYYY/MM/extra (4 segments where 3rd is sha but 4th is not a valid doc tail)', () => {
      expect(parseHistoryPath('2026/08/abc12345/../etc')).toBeNull()
    })

    it('rejects YYYY/MM/extra (3rd segment not a SHA)', () => {
      expect(parseHistoryPath('2026/08/notasha')).toBeNull()
    })

    it('rejects an empty year segment (leading slash)', () => {
      expect(parseHistoryPath('/2026')).toBeNull()
    })

    it('rejects an empty trailing segment (trailing slash)', () => {
      expect(parseHistoryPath('2026/')).toBeNull()
    })

    it('rejects a year followed by a 3-digit segment (not YYYY/MM)', () => {
      expect(parseHistoryPath('2026/123')).toBeNull()
    })

    it('rejects a 4-digit year followed by a 4-digit segment (not YYYY/MM)', () => {
      expect(parseHistoryPath('2026/1234')).toBeNull()
    })
  })
})
