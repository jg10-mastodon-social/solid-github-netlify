import verifier from '@solid/access-token-verifier'

export interface TokenPayload {
  webid: string
  client_id: string
  iss: string
  iat: number
  exp: number
  cnf?: {
    jkt: string
  }
}

export interface AuthResult {
  success: true
  payload: TokenPayload
}

export interface AuthError {
  success: false
  statusCode: 401 | 403
  message: string
}

export type AuthResponse = AuthResult | AuthError

export function isIatTimestampError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.message.includes('"iat" claim timestamp check failed')
  }
  return false
}

function parseJwtPayload(
  token: string
): { header: Record<string, unknown>; payload: Record<string, unknown> } | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const decode = (part: string) =>
      JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
    return { header: decode(parts[0]), payload: decode(parts[1]) }
  } catch {
    return null
  }
}

export function logIatTimeDifference(authHeader: string | undefined): void {
  if (!authHeader) return
  const token = authHeader.replace(/^DPoP\s+/i, '')
  const parsed = parseJwtPayload(token)
  console.log(`[auth] Token payload: ${JSON.stringify(parsed?.payload)}`)
  if (!parsed || typeof parsed.payload.iat !== 'number') return
  const iatTimestamp = parsed.payload.iat as number
  const currentTimestamp = Math.floor(Date.now() / 1000)
  const diffSeconds = currentTimestamp - iatTimestamp
  const direction = diffSeconds >= 0 ? 'behind' : 'ahead'
  console.log(
    `[auth] Token iat timestamp is ${Math.abs(diffSeconds)} seconds ${direction} server time`
  )
}

export async function verifyDpopToken(
  authHeader: string | undefined,
  dpopHeader: string | undefined,
  expectedUrl: string,
  expectedMethod: string,
  writeWebIds: string[]
): Promise<AuthResponse> {
  console.log(`[auth] ${expectedMethod} ${expectedUrl}`)

  if (!authHeader) {
    console.log(`[auth] DENIED: No Authorization header`)
    return { success: false, statusCode: 401, message: 'Authorization required' }
  }

  if (!dpopHeader) {
    console.log(`[auth] DENIED: No DPoP header`)
    return { success: false, statusCode: 401, message: 'DPoP header required' }
  }

  const dpopValue = Array.isArray(dpopHeader) ? dpopHeader[0] : dpopHeader

  try {
    const payload = await verifier.createSolidTokenVerifier()(
      authHeader,
      {
        header: dpopValue,
        method: expectedMethod as
          | 'GET'
          | 'POST'
          | 'PUT'
          | 'DELETE'
          | 'PATCH'
          | 'OPTIONS'
          | 'HEAD',
        url: expectedUrl,
      }
    )

    console.log(`[auth] Token verified, webId: ${payload.webid}`)

    if (writeWebIds.length > 0 && !writeWebIds.includes(payload.webid)) {
      console.log(`[auth] DENIED: WebID not allowed: ${payload.webid}`)
      return { success: false, statusCode: 403, message: 'WebID not allowed' }
    }

    return { success: true, payload: payload as TokenPayload }
  } catch (error) {
    console.log(`[auth] DENIED: Token verification failed: ${error}`)
    if (isIatTimestampError(error)) {
      logIatTimeDifference(authHeader)
    }
    const token = authHeader?.replace(/^DPoP\s+/i, '')
    const parsed = parseJwtPayload(token)
    console.log('[auth] Parsed JWT header:', JSON.stringify(parsed?.header))
    console.log('[auth] Parsed JWT payload:', JSON.stringify(parsed?.payload))
    const dpopParsed = parseJwtPayload(dpopValue)
    console.log('[auth] Parsed DPoP header:', JSON.stringify(dpopParsed?.header))
    console.log('[auth] Parsed DPoP payload:', JSON.stringify(dpopParsed?.payload))
    return {
      success: false,
      statusCode: 401,
      message: error instanceof Error ? error.message : 'Token verification failed',
    }
  }
}