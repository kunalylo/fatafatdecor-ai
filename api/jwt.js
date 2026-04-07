import { SignJWT, jwtVerify } from 'jose'
import { JWT_SECRET } from './config.js'

function getSecret() {
  if (!JWT_SECRET) throw new Error('JWT_SECRET env var not set')
  return new TextEncoder().encode(JWT_SECRET)
}

export async function signToken(payload) {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(getSecret())
}

export async function verifyToken(token) {
  try {
    const { payload } = await jwtVerify(token, getSecret())
    return payload
  } catch {
    return null
  }
}

/** Extract user_id from Bearer token header, fallback to explicit id (backward compat) */
export async function getUserIdFromRequest(req, fallbackId = null) {
  const auth = req.headers['authorization'] || ''
  if (auth.startsWith('Bearer ')) {
    const payload = await verifyToken(auth.slice(7))
    if (payload?.user_id) return payload.user_id
  }
  return fallbackId || null
}
