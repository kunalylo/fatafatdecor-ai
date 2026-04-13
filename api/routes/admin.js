import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { connectToMongo } from '../db.js'
import { hashPwd, asyncRoute } from '../helpers.js'

const router = Router()

// POST /admin/block-slot
router.post('/admin/block-slot', asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const { date, hour, blocked } = req.body
  if (!date || hour === undefined) return err('date and hour required')
  if (blocked) {
    await db.collection('blocked_slots').updateOne({ date, hour }, { $set: { date, hour, blocked: true, updated_at: new Date() } }, { upsert: true })
  } else {
    await db.collection('blocked_slots').deleteOne({ date, hour })
  }
  return ok({ success: true, date, hour, blocked })
}))

// GET /admin/blocked-slots
router.get('/admin/blocked-slots', asyncRoute(async (req, res, ok, err) => {
  const db   = await connectToMongo()
  const date = req.query.date
  if (!date) return err('date required')
  const blocked = await db.collection('blocked_slots').find({ date }).toArray()
  return ok({ date, blocked_hours: blocked.map(b => b.hour) })
}))

// ── Sub-admins CRUD ────────────────────────────────────────────

// GET /admin/sub-admins
router.get('/admin/sub-admins', asyncRoute(async (req, res, ok) => {
  const db   = await connectToMongo()
  const subs = await db.collection('users').find({ role: 'sub_admin' }).sort({ created_at: -1 }).toArray()
  return ok(subs.map(({ _id, password, ...u }) => u))
}))

// POST /admin/sub-admins
router.post('/admin/sub-admins', asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const { name, email, password, permissions } = req.body
  if (!name || !email || !password) return err('Name, email, password required')
  const existing = await db.collection('users').findOne({ email })
  if (existing) return err('Email already registered')
  const sub = { id: uuidv4(), name, email, phone: '', password: hashPwd(password), role: 'sub_admin', permissions: permissions || [], credits: 0, has_purchased_credits: false, location: null, auth_provider: 'email', created_at: new Date() }
  await db.collection('users').insertOne(sub)
  const { _id, password: _, ...safe } = sub
  return ok(safe)
}))

// PUT /admin/sub-admins/:id
router.put('/admin/sub-admins/:id', asyncRoute(async (req, res, ok, err) => {
  const db   = await connectToMongo()
  const body = req.body; delete body._id; delete body.password; body.updated_at = new Date()
  await db.collection('users').updateOne({ id: req.params.id, role: 'sub_admin' }, { $set: body })
  const sub = await db.collection('users').findOne({ id: req.params.id })
  if (!sub) return err('Sub-admin not found', 404)
  const { _id, password, ...safe } = sub
  return ok(safe)
}))

// DELETE /admin/sub-admins/:id
router.delete('/admin/sub-admins/:id', asyncRoute(async (req, res, ok) => {
  const db = await connectToMongo()
  await db.collection('users').deleteOne({ id: req.params.id, role: 'sub_admin' })
  return ok({ success: true })
}))

// ── Admin Users (customers) ────────────────────────────────────

// GET /admin/users
router.get('/admin/users', asyncRoute(async (req, res, ok) => {
  const db     = await connectToMongo()
  const search = req.query.search || ''
  const query  = { role: { $in: ['user', 'admin'] } }
  if (search) query.$or = [
    { name:  { $regex: search, $options: 'i' } },
    { email: { $regex: search, $options: 'i' } },
    { phone: { $regex: search, $options: 'i' } },
  ]
  const users = await db.collection('users').find(query).sort({ created_at: -1 }).limit(100).toArray()
  return ok(users.map(({ _id, password, ...u }) => u))
}))

// PUT /admin/users/:id
router.put('/admin/users/:id', asyncRoute(async (req, res, ok, err) => {
  const db   = await connectToMongo()
  const body = req.body; delete body._id; delete body.password
  if (body.new_password) { body.password = hashPwd(body.new_password); delete body.new_password }
  await db.collection('users').updateOne({ id: req.params.id }, { $set: body })
  const u = await db.collection('users').findOne({ id: req.params.id })
  if (!u) return err('User not found', 404)
  const { _id, password, ...safe } = u
  return ok(safe)
}))

// DELETE /admin/users/:id
router.delete('/admin/users/:id', asyncRoute(async (req, res, ok) => {
  const db = await connectToMongo()
  await db.collection('users').deleteOne({ id: req.params.id })
  await db.collection('orders').deleteMany({ user_id: req.params.id })
  await db.collection('designs').deleteMany({ user_id: req.params.id })
  return ok({ success: true })
}))

// ── Admin DP toggle ────────────────────────────────────────────

// POST /admin/dp-toggle
router.post('/admin/dp-toggle', asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const { dp_id } = req.body
  const dp = await db.collection('delivery_persons').findOne({ id: dp_id })
  if (!dp) return err('Decorator not found', 404)
  const newStatus = !dp.is_active
  await db.collection('delivery_persons').updateOne({ id: dp_id }, { $set: { is_active: newStatus } })
  return ok({ success: true, is_active: newStatus })
}))

// ── Admin Orders ───────────────────────────────────────────────

// PUT /orders/:id  (admin full update)
router.put('/orders/:id', asyncRoute(async (req, res, ok, err) => {
  const db   = await connectToMongo()
  const body = req.body; delete body._id
  await db.collection('orders').updateOne({ id: req.params.id }, { $set: body })
  const o = await db.collection('orders').findOne({ id: req.params.id })
  if (!o) return err('Order not found', 404)
  const { _id, ...clean } = o
  return ok(clean)
}))

// ── Admin Gifts CRUD ──────────────────────────────────────────

// GET /admin/gifts — all gifts (including inactive)
router.get('/admin/gifts', asyncRoute(async (req, res, ok) => {
  const db = await connectToMongo()
  const gifts = await db.collection('gifts').find({}).sort({ sr: 1, name: 1 }).toArray()
  return ok(gifts.map(({ _id, ...g }) => g))
}))

// POST /admin/gifts — create gift
router.post('/admin/gifts', asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const { name, description, price, image_url, sr } = req.body
  if (!name) return err('Gift name required')
  const gift = {
    id: uuidv4(), name, description: description || '',
    price: Number(price) || 0, image_url: image_url || '',
    sr: Number(sr) || 0, active: true, is_active: true,
    created_at: new Date()
  }
  await db.collection('gifts').insertOne(gift)
  const { _id, ...clean } = gift
  return ok(clean)
}))

// PUT /admin/gifts/:id — update gift
router.put('/admin/gifts/:id', asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const body = req.body; delete body._id
  if (body.price !== undefined) body.price = Number(body.price)
  if (body.sr !== undefined) body.sr = Number(body.sr)
  if (body.active !== undefined) body.is_active = body.active
  body.updated_at = new Date()
  await db.collection('gifts').updateOne({ id: req.params.id }, { $set: body })
  const gift = await db.collection('gifts').findOne({ id: req.params.id })
  if (!gift) return err('Gift not found', 404)
  const { _id, ...clean } = gift
  return ok(clean)
}))

// DELETE /admin/gifts/:id — delete gift
router.delete('/admin/gifts/:id', asyncRoute(async (req, res, ok) => {
  const db = await connectToMongo()
  await db.collection('gifts').deleteOne({ id: req.params.id })
  return ok({ success: true })
}))

// GET /admin/gift-orders — all gift orders
router.get('/admin/gift-orders', asyncRoute(async (req, res, ok) => {
  const db = await connectToMongo()
  const orders = await db.collection('gift_orders').find({}).sort({ created_at: -1 }).toArray()
  return ok(orders.map(({ _id, ...o }) => o))
}))

export default router
