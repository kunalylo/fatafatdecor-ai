import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { connectToMongo } from '../db.js'
import { isCityAllowed, asyncRoute } from '../helpers.js'

const router = Router()

// GET /cities
router.get('/cities', asyncRoute(async (req, res, ok) => {
  const db     = await connectToMongo()
  const cities = await db.collection('allowed_cities').find({}).sort({ name: 1 }).toArray()
  return ok(cities.map(({ _id, ...c }) => c))
}))

// POST /cities
router.post('/cities', asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const { name, state } = req.body
  if (!name) return err('City name required')
  const existing = await db.collection('allowed_cities').findOne({ name: { $regex: new RegExp('^' + name + '$', 'i') } })
  if (existing) return err('City already exists')
  const city = { id: uuidv4(), name: name.trim(), state: state || '', active: true, created_at: new Date() }
  await db.collection('allowed_cities').insertOne(city)
  const { _id, ...clean } = city
  return ok(clean)
}))

// PUT /cities/:id
router.put('/cities/:id', asyncRoute(async (req, res, ok, err) => {
  const db   = await connectToMongo()
  const body = req.body; delete body._id
  await db.collection('allowed_cities').updateOne({ id: req.params.id }, { $set: body })
  const city = await db.collection('allowed_cities').findOne({ id: req.params.id })
  if (!city) return err('City not found', 404)
  const { _id, ...clean } = city
  return ok(clean)
}))

// DELETE /cities/:id
router.delete('/cities/:id', asyncRoute(async (req, res, ok) => {
  const db = await connectToMongo()
  await db.collection('allowed_cities').deleteOne({ id: req.params.id })
  return ok({ success: true })
}))

// POST /city-check
router.post('/city-check', asyncRoute(async (req, res, ok) => {
  const db      = await connectToMongo()
  const { city } = req.body
  const allowed = await isCityAllowed(db, city)
  const cities  = await db.collection('allowed_cities').find({ active: true }).sort({ name: 1 }).toArray()
  return ok({ allowed, city, active_cities: cities.map(c => c.name) })
}))

export default router
