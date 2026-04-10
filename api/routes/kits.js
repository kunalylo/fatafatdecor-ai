import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { connectToMongo } from '../db.js'
import { requireAdmin } from '../jwt.js'
import { asyncRoute } from '../helpers.js'
import { AI_SERVICE_URL } from '../config.js'

const router = Router()

// GET /kits — public read
router.get('/kits', asyncRoute(async (req, res, ok) => {
  const db    = await connectToMongo()
  const query = {}
  if (req.query.occasion) query.occasion_tags = req.query.occasion
  const kits  = await db.collection('decoration_kits').find(query).sort({ created_at: -1 }).toArray()
  return ok(kits.map(({ _id, ...k }) => k))
}))

// GET /kits/match — public read
router.get('/kits/match', asyncRoute(async (req, res, ok) => {
  const db    = await connectToMongo()
  const query = { is_active: true }
  if (req.query.occasion) query.occasion_tags = req.query.occasion
  let kits = await db.collection('decoration_kits').find(query).toArray()
  if (kits.length === 0) kits = await db.collection('decoration_kits').find({ is_active: true }).toArray()
  return ok(kits.map(({ _id, ...k }) => k))
}))

// GET /kits/reference-images — public read (no base64 returned)
router.get('/kits/reference-images', asyncRoute(async (req, res, ok) => {
  const db   = await connectToMongo()
  const refs = await db.collection('reference_images').find({}).sort({ created_at: -1 }).toArray()
  return ok(refs.map(({ _id, image_base64, ...r }) => ({ ...r, has_image: !!image_base64 })))
}))

// POST /kits/reference-images — admin only
router.post('/kits/reference-images', requireAdmin, asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const { name, image_base64, tags, occasion, description } = req.body
  if (!name || !image_base64) return err('name and image_base64 required')
  const ref = { id: uuidv4(), name, image_base64, tags: tags || [], occasion: occasion || '', description: description || '', created_at: new Date() }
  await db.collection('reference_images').insertOne(ref)
  const { _id, ...clean } = ref
  return ok(clean)
}))

// DELETE /kits/reference-images/:id — admin only
router.delete('/kits/reference-images/:id', requireAdmin, asyncRoute(async (req, res, ok) => {
  const db = await connectToMongo()
  await db.collection('reference_images').deleteOne({ id: req.params.id })
  return ok({ success: true })
}))

// POST /kits/analyze — admin only
router.post('/kits/analyze', requireAdmin, asyncRoute(async (req, res, ok, err) => {
  const { image_base64, name } = req.body
  if (!image_base64) return err('image_base64 required')
  const controller = new AbortController()
  const timeout    = setTimeout(() => controller.abort(), 60000)
  const aiRes = await fetch(`${AI_SERVICE_URL}/analyze-decoration`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image_base64, name: name || '' }), signal: controller.signal,
  })
  clearTimeout(timeout)
  return ok(await aiRes.json())
}))

// GET /kits/:id — public read
router.get('/kits/:id', asyncRoute(async (req, res, ok, err) => {
  const db  = await connectToMongo()
  const kit = await db.collection('decoration_kits').findOne({ id: req.params.id })
  if (!kit) return err('Kit not found', 404)
  const { _id, ...clean } = kit
  return ok(clean)
}))

// POST /kits — admin only
router.post('/kits', requireAdmin, asyncRoute(async (req, res, ok, err) => {
  const db   = await connectToMongo()
  const body = req.body
  if (!body.name) return err('Kit name required')
  const kit = {
    id: uuidv4(), name: body.name, description: body.description || '',
    occasion_tags: body.occasion_tags || [], room_types: body.room_types || [],
    reference_images: body.reference_images || [], kit_items: body.kit_items || [],
    bom: body.bom || [], labor_cost: Number(body.labor_cost) || 0,
    travel_cost: Number(body.travel_cost) || 500, total_items_cost: 0,
    final_price: Number(body.final_price) || 0,
    selling_total: Number(body.selling_total || body.final_price) || 0,
    purchase_total: Number(body.purchase_total) || 0,
    setup_time_minutes: Number(body.setup_time_minutes) || 60,
    difficulty: body.difficulty || 'medium', color_theme: body.color_theme || '',
    notes: body.notes || '', is_active: body.is_active !== false, active: body.active !== false,
    kit_code: body.kit_code || '', theme: body.theme || '', audience: body.audience || '',
    created_at: new Date(), updated_at: new Date(),
  }
  kit.total_items_cost = (kit.kit_items || []).reduce((sum, i) => sum + (Number(i.unit_price) * Number(i.quantity)), 0)
  if (!kit.final_price) kit.final_price = kit.total_items_cost + kit.labor_cost + kit.travel_cost
  if (!kit.selling_total) kit.selling_total = kit.final_price
  await db.collection('decoration_kits').insertOne(kit)
  const { _id, ...clean } = kit
  return ok(clean)
}))

// PUT /kits/:id — admin only
router.put('/kits/:id', requireAdmin, asyncRoute(async (req, res, ok, err) => {
  const db   = await connectToMongo()
  const body = req.body; delete body._id; body.updated_at = new Date()
  await db.collection('decoration_kits').updateOne({ id: req.params.id }, { $set: body })
  const kit = await db.collection('decoration_kits').findOne({ id: req.params.id })
  if (!kit) return err('Kit not found', 404)
  const { _id, ...clean } = kit
  return ok(clean)
}))

// DELETE /kits/:id — admin only
router.delete('/kits/:id', requireAdmin, asyncRoute(async (req, res, ok) => {
  const db = await connectToMongo()
  await db.collection('decoration_kits').deleteOne({ id: req.params.id })
  return ok({ success: true })
}))

export default router
