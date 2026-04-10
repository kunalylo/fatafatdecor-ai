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

/** Express middleware: require a customer JWT. Attaches req.userId + req.userRole. */
export async function requireUser(req, res, next) {
  const auth = req.headers['authorization'] || ''
  if (!auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Authentication required' })
  const payload = await verifyToken(auth.slice(7))
  if (!payload || !payload.user_id) return res.status(401).json({ error: 'Invalid or expired token' })
  req.userId = payload.user_id
  req.userRole = payload.role || 'user'
  next()
}

/** Extract decorator id from Bearer token. Returns null if missing/invalid. */
export async function getDpIdFromRequest(req) {
  const auth = req.headers['authorization'] || ''
  if (!auth.startsWith('Bearer ')) return null
  const payload = await verifyToken(auth.slice(7))
  if (!payload || payload.role !== 'decorator' || !payload.dp_id) return null
  return payload.dp_id
}

/** Express middleware: require decorator JWT, attach req.dpId */
export async function requireDp(req, res, next) {
  const dpId = await getDpIdFromRequest(req)
  if (!dpId) return res.status(401).json({ error: 'Unauthorized: decorator token required' })
  req.dpId = dpId
  next()
}

/** Express middleware: require admin or sub_admin JWT, attach req.adminId + req.adminRole. */
export async function requireAdmin(req, res, next) {
  const auth = req.headers['authorization'] || ''
  if (!auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized: admin token required' })
  const payload = await verifyToken(auth.slice(7))
  if (!payload) return res.status(401).json({ error: 'Invalid or expired token' })
  const role = payload.role
  if (role !== 'admin' && role !== 'sub_admin') {
    return res.status(403).json({ error: 'Admin access required' })
  }
  req.adminId = payload.user_id || payload.admin_id || null
  req.adminRole = role
  next()
}
