import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export default function setup() {
  const generated = join(
    process.cwd(),
    'netlify',
    'functions',
    'router',
    'repo-start-year.generated.mjs'
  )
  if (existsSync(generated)) return
  const result = spawnSync('node', ['scripts/derive-repo-start-year.mjs'], {
    stdio: 'inherit',
    env: process.env
  })
  if (result.status !== 0) {
    throw new Error(
      `derive-repo-start-year.mjs failed with exit code ${result.status}`
    )
  }
}
