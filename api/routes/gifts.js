import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { connectToMongo } from '../db.js'
import { requireUser, requireDp } from '../jwt.js'
import { asyncRoute } from '../helpers.js'

const router = Router()

// POST /gift-orders — requires JWT
router.post('/gift-orders', requireUser, asyncRoute(async (req, res, ok, err) => {
  const db   = await connectToMongo()
  const user_id = req.userId
  const { delivery_address, delivery_landmark, delivery_lat, delivery_lng, gift_items } = req.body
  if (!Array.isArray(gift_items) || gift_items.length === 0) return err('gift_items array required')
  const giftTotal = gift_items.reduce((s, g) => s + (Number(g.price) || 0) * (Number(g.quantity) || 1), 0)
  const giftOrder = {
    id: uuidv4(), user_id, order_type: 'gift', gift_items, gift_total: giftTotal,
    delivery_address: delivery_address || '', delivery_landmark: delivery_landmark || '',
    delivery_location: { lat: delivery_lat || null, lng: delivery_lng || null },
    delivery_slot: null, payment_status: 'pending', payment_amount: 0,
    // 'awaiting_payment' — decorators notified only after payment verified
    delivery_status: 'awaiting_payment', delivery_person_id: null,
    assigned_decorators: [], accepted_decorators: [], created_at: new Date(),
  }
  await db.collection('gift_orders').insertOne(giftOrder)
  // Decorator assignment happens in /payments/verify — not here
  const { _id, ...clean } = giftOrder
  return ok(clean)
}))

// GET /gift-orders — requires JWT, only own orders
router.get('/gift-orders', requireUser, asyncRoute(async (req, res, ok) => {
  const db     = await connectToMongo()
  const orders = await db.collection('gift_orders').find({ user_id: req.userId }).sort({ created_at: -1 }).limit(50).toArray()
  return ok(orders.map(({ _id, ...o }) => o))
}))

// GET /gift-orders/:id — requires JWT, only own order
router.get('/gift-orders/:id', requireUser, asyncRoute(async (req, res, ok, err) => {
  const db    = await connectToMongo()
  const order = await db.collection('gift_orders').findOne({ id: req.params.id })
  if (!order) return err('Gift order not found', 404)
  if (order.user_id !== req.userId) return err('Not authorized', 403)
  const { _id, ...clean } = order
  return ok(clean)
}))

// POST /gift-orders/:id/request-slot — requires JWT
router.post('/gift-orders/:id/request-slot', requireUser, asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const { date, hour } = req.body
  if (!date || hour === undefined) return err('date and hour required')
  const order = await db.collection('gift_orders').findOne({ id: req.params.id })
  if (!order) return err('Gift order not found', 404)
  if (order.user_id !== req.userId) return err('Not authorized', 403)
  if (order.payment_status !== 'full') return err('Gift order must be paid before booking a slot', 402)
  await db.collection('gift_orders').updateOne({ id: req.params.id }, { $set: { requested_slot: { date, hour }, delivery_slot: { date, hour } } })
  return ok({ success: true })
}))

// ── DP: Gift Order routes ──────────────────────────────────────

// POST /dp/accept-gift-order
router.post('/dp/accept-gift-order', requireDp, asyncRoute(async (req, res, ok, err) => {
  const db   = await connectToMongo()
  const dpId = req.dpId
  const { order_id } = req.body
  if (!order_id) return err('order_id required')
  const dp        = await db.collection('delivery_persons').findOne({ id: dpId })
  if (!dp) return err('Decorator not found', 404)
  const giftOrder = await db.collection('gift_orders').findOne({ id: order_id })
  if (!giftOrder) return err('Gift order not found', 404)
  if (!(giftOrder.assigned_decorators || []).includes(dpId)) return err('Gift order not assigned to you', 403)
  if ((giftOrder.accepted_decorators || []).includes(dpId)) return err('You have already accepted this gift order')
  const update = { $addToSet: { accepted_decorators: dpId } }
  if (!giftOrder.delivery_person_id) update.$set = { delivery_person_id: dpId, delivery_status: 'assigned' }
  await db.collection('gift_orders').updateOne({ id: order_id }, update)
  return ok({ success: true, message: 'Gift order accepted successfully' })
}))

// POST /dp/decline-gift-order
router.post('/dp/decline-gift-order', requireDp, asyncRoute(async (req, res, ok, err) => {
  const db   = await connectToMongo()
  const dpId = req.dpId
  const { order_id } = req.body
  if (!order_id) return err('order_id required')
  const giftOrder = await db.collection('gift_orders').findOne({ id: order_id })
  if (!giftOrder) return err('Gift order not found', 404)
  await db.collection('gift_orders').updateOne(
    { id: order_id },
    { $pull: { assigned_decorators: dpId, accepted_decorators: dpId } }
  )
  return ok({ success: true, message: 'Gift order declined' })
}))

// POST /dp/update-gift-status
router.post('/dp/update-gift-status', requireDp, asyncRoute(async (req, res, ok, err) => {
  const db   = await connectToMongo()
  const dpId = req.dpId
  const { order_id, status } = req.body
  if (!order_id || !status) return err('order_id and status required')
  const VALID = ['assigned','en_route','arrived','delivered']
  if (!VALID.includes(status)) return err('Invalid status. Must be one of: assigned, en_route, arrived, delivered', 400)
  const giftOrder = await db.collection('gift_orders').findOne({ id: order_id })
  if (!giftOrder) return err('Gift order not found', 404)
  const isAssigned = (giftOrder.accepted_decorators || []).includes(dpId) || giftOrder.delivery_person_id === dpId
  if (!isAssigned) return err('Not authorized to update this gift order', 403)
  await db.collection('gift_orders').updateOne({ id: order_id }, { $set: { delivery_status: status } })
  return ok({ success: true })
}))

// GET /dp/gift-order-detail/:id
router.get('/dp/gift-order-detail/:id', requireDp, asyncRoute(async (req, res, ok, err) => {
  const db        = await connectToMongo()
  const dpId      = req.dpId
  const giftOrder = await db.collection('gift_orders').findOne({ id: req.params.id })
  if (!giftOrder) return err('Gift order not found', 404)
  const isAssigned =
    (giftOrder.accepted_decorators || []).includes(dpId) ||
    (giftOrder.assigned_decorators || []).includes(dpId) ||
    giftOrder.delivery_person_id === dpId
  if (!isAssigned) return err('Not authorized for this gift order', 403)
  const customer  = await db.collection('users').findOne({ id: giftOrder.user_id })
  const { _id: _g1, ...cleanGiftOrder } = giftOrder
  const { _id: _g2, password: _g3, ...safeCustomer } = customer || {}
  return ok({ ...cleanGiftOrder, customer: safeCustomer })
}))

export default router
