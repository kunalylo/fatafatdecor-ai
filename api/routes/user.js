import { Router } from 'express'
import { connectToMongo } from '../db.js'
import { requireUser } from '../jwt.js'
import { hashPwd, asyncRoute } from '../helpers.js'

const router = Router()

// POST /user/location — requires JWT, updates own location only
router.post('/user/location', requireUser, asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const { lat, lng } = req.body
  if (!lat || !lng) return err('lat and lng required', 400)
  await db.collection('users').updateOne(
    { id: req.userId },
    { $set: { location: { lat: Number(lat), lng: Number(lng), updated_at: new Date() } } }
  )
  return ok({ success: true })
}))

// GET /credits — requires JWT, returns own credit balance only
router.get('/credits', requireUser, asyncRoute(async (req, res, ok, err) => {
  const db   = await connectToMongo()
  const user = await db.collection('users').findOne({ id: req.userId })
  if (!user) return err('User not found', 404)
  return ok({ user_id: user.id, credits: user.credits || 0 })
}))

// Keep legacy route for backward compat — still gated by JWT, ignores param
router.get('/credits/:userId', requireUser, asyncRoute(async (req, res, ok, err) => {
  const db   = await connectToMongo()
  const user = await db.collection('users').findOne({ id: req.userId })
  if (!user) return err('User not found', 404)
  return ok({ user_id: user.id, credits: user.credits || 0 })
}))

// PUT /user/profile — update own name/phone
router.put('/user/profile', requireUser, asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const { name, phone } = req.body
  const update = {}
  if (name && typeof name === 'string' && name.trim().length >= 2) update.name = name.trim()
  if (phone) {
    const clean = String(phone).replace(/\D/g, '')
    if (clean.length === 10) update.phone = clean
    else return err('Phone must be 10 digits', 400)
  }
  if (Object.keys(update).length === 0) return err('Nothing to update', 400)
  update.updated_at = new Date()
  await db.collection('users').updateOne({ id: req.userId }, { $set: update })
  const user = await db.collection('users').findOne({ id: req.userId })
  if (!user) return err('User not found', 404)
  const { _id, password, ...safe } = user
  return ok(safe)
}))

// POST /user/change-password — change own password
router.post('/user/change-password', requireUser, asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const { current_password, new_password } = req.body
  if (!current_password || !new_password) return err('Both current and new password required', 400)
  if (new_password.length < 6) return err('New password must be at least 6 characters', 400)

  const user = await db.collection('users').findOne({ id: req.userId })
  if (!user) return err('User not found', 404)

  // Google-only users may not have a password — allow them to set one
  if (user.password) {
    if (hashPwd(current_password) !== user.password) return err('Current password is incorrect', 401)
  }

  await db.collection('users').updateOne(
    { id: req.userId },
    { $set: { password: hashPwd(new_password), updated_at: new Date() } }
  )
  return ok({ success: true })
}))

export default router
