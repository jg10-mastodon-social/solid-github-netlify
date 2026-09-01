import { spawn, ChildProcess } from 'child_process'

const DEV_PORT = 9999
const DEV_URL = `http://localhost:${DEV_PORT}`

let serverProcess: ChildProcess | null = null
let serverReady = false

export const devServerUrl = DEV_URL

export async function waitForServer(url: string, timeout: number): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    try {
      const response = await fetch(`${url}/foo/bar`)
      // Any HTTP response means the server is up; we don't care about status code here.
      if (response.status > 0) {
        return
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error(`Server failed to start within ${timeout}ms`)
}

export async function startDevServer(): Promise<void> {
  if (serverReady) return

  console.log('Starting netlify dev...')

  return new Promise((resolve, reject) => {
    serverProcess = spawn('npx', ['netlify', 'dev', '--context', 'dev', '--port', String(DEV_PORT), '--offline'], {
      stdio: 'pipe'
    })

    let output = ''
    serverProcess.stdout?.on('data', (data) => {
      const text = data.toString()
      output += text
      console.log(`[netlify] ${text.trim()}`)
    })
    serverProcess.stderr?.on('data', (data) => {
      const text = data.toString()
      output += text
      console.error(`[netlify] ${text.trim()}`)
    })

    serverProcess.on('error', (err) => {
      console.error('Server error:', err)
      reject(err)
    })

    waitForServer(DEV_URL, 30000)
      .then(() => {
        serverReady = true
        console.log('Server is ready')
        resolve()
      })
      .catch((err) => {
        console.error('Server failed to start. Output:', output)
        reject(err)
      })
  })
}

export function stopDevServer(): void {
  if (serverProcess) {
    console.log('Stopping netlify dev...')
    serverProcess.kill()
    serverProcess = null
    serverReady = false
  }
}
