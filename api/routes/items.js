import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { connectToMongo } from '../db.js'
import { requireAdmin } from '../jwt.js'
import { asyncRoute } from '../helpers.js'

const router = Router()

// GET /items — public read
router.get('/items', asyncRoute(async (req, res, ok) => {
  const db       = await connectToMongo()
  const query    = {}
  if (req.query.category) query.category = req.query.category
  const items    = await db.collection('items').find(query).toArray()
  return ok(items.map(({ _id, ...item }) => item))
}))

// POST /items — admin only
router.post('/items', requireAdmin, asyncRoute(async (req, res, ok) => {
  const db   = await connectToMongo()
  const body = req.body
  const item = {
    id: uuidv4(), name: body.name, description: body.description || '',
    category: body.category || 'general',
    price: Number(body.selling_price_unit || body.price || 0),
    selling_price_unit: Number(body.selling_price_unit || body.price || 0),
    unit_cost: Number(body.unit_cost || 0),
    color: body.color || '', size: body.size || '',
    image_url: body.image_url || '',
    stock_count: Number(body.stock_count) || 0,
    tags: body.tags || [],
    is_rentable: body.is_rentable || false,
    is_sellable: body.is_sellable !== false,
    active: true, created_at: new Date(),
  }
  await db.collection('items').insertOne(item)
  const { _id, ...clean } = item
  return ok(clean)
}))

// PUT /items/:id — admin only
router.put('/items/:id', requireAdmin, asyncRoute(async (req, res, ok, err) => {
  const db   = await connectToMongo()
  const body = req.body; delete body._id
  await db.collection('items').updateOne({ id: req.params.id }, { $set: body })
  const item = await db.collection('items').findOne({ id: req.params.id })
  if (!item) return err('Item not found', 404)
  const { _id, ...clean } = item
  return ok(clean)
}))

// DELETE /items/:id — admin only
router.delete('/items/:id', requireAdmin, asyncRoute(async (req, res, ok) => {
  const db = await connectToMongo()
  await db.collection('items').deleteOne({ id: req.params.id })
  return ok({ success: true })
}))

// GET /rent-items — public read
router.get('/rent-items', asyncRoute(async (req, res, ok) => {
  const db    = await connectToMongo()
  const items = await db.collection('rent_items').find({}).toArray()
  return ok(items.map(({ _id, ...i }) => i))
}))

// GET /gifts — public read
router.get('/gifts', asyncRoute(async (req, res, ok) => {
  const db    = await connectToMongo()
  const gifts = await db.collection('gifts').find({ $or: [{ active: true }, { is_active: true }] }).sort({ sr: 1, name: 1 }).toArray()
  return ok(gifts.map(({ _id, ...g }) => ({
    ...g,
    active:    true,
    image_url: g.image_url
      ? g.image_url.split('/').map((seg, i) => i >= 3 ? encodeURIComponent(seg) : seg).join('/')
      : '',
  })), 300)
}))

export default router
