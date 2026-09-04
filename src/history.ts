export type HistoryPathKind =
  | 'history_root'
  | 'year'
  | 'month'
  | 'commit_folder'
  | 'commit_file'

export interface HistoryPathBase {
  kind: HistoryPathKind
  bucketPrefix?: string
}

export interface HistoryRoot extends HistoryPathBase {
  kind: 'history_root'
}

export interface YearPath extends HistoryPathBase {
  kind: 'year'
  year: number
}

export interface MonthPath extends HistoryPathBase {
  kind: 'month'
  year: number
  month: number
}

export interface CommitFolderPath extends HistoryPathBase {
  kind: 'commit_folder'
  shortSha: string
}

export interface CommitFilePath extends HistoryPathBase {
  kind: 'commit_file'
  shortSha: string
  doc: string
}

export type HistoryPath =
  | HistoryRoot
  | YearPath
  | MonthPath
  | CommitFolderPath
  | CommitFilePath

const YEAR_RE = /^\d{4}$/
const MONTH_RE = /^\d{2}$/
const SHA_RE = /^[a-f0-9]{7,40}$/

const UNSAFE_SEGMENTS = new Set(['', '.', '..'])

export function parseHistoryPath(rest: string): HistoryPath | null {
  if (rest === '') {
    return { kind: 'history_root' }
  }

  if (rest === 'draft' || rest.startsWith('draft/')) {
    return null
  }

  const segments = rest.split('/')
  for (const seg of segments) {
    if (UNSAFE_SEGMENTS.has(seg)) return null
  }

  if (segments.length === 1) {
    return parseSingleSegment(segments[0]!)
  }

  if (segments.length === 2) {
    return parseTwoSegments(segments[0]!, segments[1]!)
  }

  return parseThreeOrMoreSegments(segments)
}

function parseSingleSegment(seg: string): HistoryPath | null {
  if (YEAR_RE.test(seg)) {
    return { kind: 'year', year: Number(seg) }
  }
  if (SHA_RE.test(seg)) {
    return { kind: 'commit_folder', shortSha: seg }
  }
  return null
}

function parseTwoSegments(first: string, second: string): HistoryPath | null {
  if (YEAR_RE.test(first) && MONTH_RE.test(second)) {
    const month = Number(second)
    if (month >= 1 && month <= 12) {
      return { kind: 'month', year: Number(first), month }
    }
    return null
  }
  if (SHA_RE.test(first)) {
    return {
      kind: 'commit_file',
      shortSha: first,
      doc: second
    }
  }
  if (YEAR_RE.test(first) && SHA_RE.test(second)) {
    return {
      kind: 'commit_folder',
      shortSha: second,
      bucketPrefix: first
    }
  }
  return null
}

function parseThreeOrMoreSegments(segments: string[]): HistoryPath | null {
  const first = segments[0]!
  const second = segments[1]!
  const third = segments[2]!
  const tail = segments.slice(3)

  if (YEAR_RE.test(first) && MONTH_RE.test(second) && SHA_RE.test(third)) {
    const month = Number(second)
    if (month < 1 || month > 12) return null
    if (tail.length === 0) {
      return {
        kind: 'commit_folder',
        shortSha: third,
        bucketPrefix: `${first}/${second}`
      }
    }
    return {
      kind: 'commit_file',
      shortSha: third,
      doc: tail.join('/'),
      bucketPrefix: `${first}/${second}`
    }
  }

  if (YEAR_RE.test(first) && SHA_RE.test(second)) {
    return {
      kind: 'commit_file',
      shortSha: second,
      doc: third ? segments.slice(2).join('/') : '',
      bucketPrefix: first
    }
  }

  if (SHA_RE.test(first)) {
    return {
      kind: 'commit_file',
      shortSha: first,
      doc: segments.slice(1).join('/')
    }
  }

  return null
}
