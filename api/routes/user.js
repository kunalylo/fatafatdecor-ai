import { Router } from 'express'
import { connectToMongo } from '../db.js'
import { getUserIdFromRequest } from '../jwt.js'
import { asyncRoute } from '../helpers.js'

const router = Router()

// POST /user/location
router.post('/user/location', asyncRoute(async (req, res, ok, err) => {
  const db      = await connectToMongo()
  const { lat, lng } = req.body
  const user_id = await getUserIdFromRequest(req, req.body.user_id)
  if (!user_id) return err('user_id required')
  await db.collection('users').updateOne({ id: user_id }, { $set: { location: { lat, lng, updated_at: new Date() } } })
  return ok({ success: true })
}))

// GET /credits/:userId
router.get('/credits/:userId', asyncRoute(async (req, res, ok, err) => {
  const db   = await connectToMongo()
  const user = await db.collection('users').findOne({ id: req.params.userId })
  if (!user) return err('User not found', 404)
  return ok({ user_id: user.id, credits: user.credits })
}))

export default router
