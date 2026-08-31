import { beforeAll, afterAll } from 'vitest'
import { startDevServer, stopDevServer } from './dev-server.js'

beforeAll(async () => {
  await startDevServer()
}, 60000)

afterAll(() => {
  stopDevServer()
})
