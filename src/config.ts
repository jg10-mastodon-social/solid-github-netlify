export interface Config {
  writeWebIds: string[]
}

export function loadConfig(): Config {
  const raw = process.env.WRITE_WEBIDS
  if (!raw) {
    throw new Error('WRITE_WEBIDS is required')
  }
  const writeWebIds = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  if (writeWebIds.length === 0) {
    throw new Error('WRITE_WEBIDS is required')
  }
  return { writeWebIds }
}