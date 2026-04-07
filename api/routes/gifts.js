import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { connectToMongo } from '../db.js'
import { getUserIdFromRequest } from '../jwt.js'
import { asyncRoute } from '../helpers.js'

const router = Router()

// POST /gift-orders
router.post('/gift-orders', asyncRoute(async (req, res, ok, err) => {
  const db   = await connectToMongo()
  const body = req.body
  const { delivery_address, delivery_landmark, delivery_lat, delivery_lng, gift_items } = body
  const user_id = await getUserIdFromRequest(req, body.user_id)
  if (!user_id) return err('user_id required')
  if (!Array.isArray(gift_items) || gift_items.length === 0) return err('gift_items array required')
  const giftTotal = gift_items.reduce((s, g) => s + (Number(g.price) || 0) * (Number(g.quantity) || 1), 0)
  const giftOrder = {
    id: uuidv4(), user_id, order_type: 'gift', gift_items, gift_total: giftTotal,
    delivery_address: delivery_address || '', delivery_landmark: delivery_landmark || '',
    delivery_location: { lat: delivery_lat || null, lng: delivery_lng || null },
    delivery_slot: null, payment_status: 'pending', payment_amount: 0,
    delivery_status: 'pending', delivery_person_id: null,
    assigned_decorators: [], accepted_decorators: [], created_at: new Date(),
  }
  await db.collection('gift_orders').insertOne(giftOrder)
  const activePersons = await db.collection('delivery_persons').find({ is_active: true }).toArray()
  if (activePersons.length > 0) {
    const assignedIds = activePersons.map(p => p.id)
    await db.collection('gift_orders').updateOne({ id: giftOrder.id }, { $set: { assigned_decorators: assignedIds } })
    giftOrder.assigned_decorators = assignedIds
  }
  const { _id, ...clean } = giftOrder
  return ok(clean)
}))

// GET /gift-orders
router.get('/gift-orders', asyncRoute(async (req, res, ok, err) => {
  const db      = await connectToMongo()
  const user_id = await getUserIdFromRequest(req, req.query.user_id)
  if (!user_id) return err('user_id required')
  const orders = await db.collection('gift_orders').find({ user_id }).sort({ created_at: -1 }).limit(50).toArray()
  return ok(orders.map(({ _id, ...o }) => o))
}))

// GET /gift-orders/:id
router.get('/gift-orders/:id', asyncRoute(async (req, res, ok, err) => {
  const db    = await connectToMongo()
  const order = await db.collection('gift_orders').findOne({ id: req.params.id })
  if (!order) return err('Gift order not found', 404)
  const { _id, ...clean } = order
  return ok(clean)
}))

// POST /gift-orders/:id/request-slot
router.post('/gift-orders/:id/request-slot', asyncRoute(async (req, res, ok, err) => {
  const db      = await connectToMongo()
  const { date, hour } = req.body
  const user_id = await getUserIdFromRequest(req, req.body.user_id)
  if (!date || hour === undefined || !user_id) return err('date, hour, user_id required')
  const order = await db.collection('gift_orders').findOne({ id: req.params.id })
  if (!order) return err('Gift order not found', 404)
  if (order.user_id !== user_id) return err('Not authorized', 403)
  await db.collection('gift_orders').updateOne({ id: req.params.id }, { $set: { requested_slot: { date, hour }, delivery_slot: { date, hour } } })
  return ok({ success: true })
}))

// ── DP: Gift Order routes ──────────────────────────────────────

// POST /dp/accept-gift-order
router.post('/dp/accept-gift-order', asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const { order_id, dp_id } = req.body
  if (!order_id || !dp_id) return err('order_id and dp_id required')
  const dp        = await db.collection('delivery_persons').findOne({ id: dp_id })
  if (!dp) return err('Delivery person not found', 404)
  const giftOrder = await db.collection('gift_orders').findOne({ id: order_id })
  if (!giftOrder) return err('Gift order not found', 404)
  if (!(giftOrder.assigned_decorators || []).includes(dp_id)) return err('Gift order not assigned to you', 403)
  if ((giftOrder.accepted_decorators || []).includes(dp_id)) return err('You have already accepted this gift order')
  const update = { $addToSet: { accepted_decorators: dp_id } }
  if (!giftOrder.delivery_person_id) update.$set = { delivery_person_id: dp_id, delivery_status: 'assigned' }
  await db.collection('gift_orders').updateOne({ id: order_id }, update)
  return ok({ success: true, message: 'Gift order accepted successfully' })
}))

// POST /dp/decline-gift-order
router.post('/dp/decline-gift-order', asyncRoute(async (req, res, ok, err) => {
  const db        = await connectToMongo()
  const { order_id, dp_id } = req.body
  if (!order_id || !dp_id) return err('order_id and dp_id required')
  const giftOrder = await db.collection('gift_orders').findOne({ id: order_id })
  if (!giftOrder) return err('Gift order not found', 404)
  await db.collection('gift_orders').updateOne({ id: order_id }, { $pull: { assigned_decorators: dp_id, accepted_decorators: dp_id } })
  return ok({ success: true, message: 'Gift order declined' })
}))

// POST /dp/update-gift-status
router.post('/dp/update-gift-status', asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const { order_id, status, dp_id } = req.body
  if (!order_id || !status || !dp_id) return err('order_id, status, dp_id required')
  const VALID = ['assigned','en_route','arrived','delivered']
  if (!VALID.includes(status)) return err('Invalid status. Must be one of: assigned, en_route, arrived, delivered', 400)
  const giftOrder = await db.collection('gift_orders').findOne({ id: order_id })
  if (!giftOrder) return err('Gift order not found', 404)
  const isAssigned = (giftOrder.accepted_decorators || []).includes(dp_id) || giftOrder.delivery_person_id === dp_id
  if (!isAssigned) return err('Not authorized to update this gift order', 403)
  await db.collection('gift_orders').updateOne({ id: order_id }, { $set: { delivery_status: status } })
  return ok({ success: true })
}))

// GET /dp/gift-order-detail/:id
router.get('/dp/gift-order-detail/:id', asyncRoute(async (req, res, ok, err) => {
  const db        = await connectToMongo()
  const giftOrder = await db.collection('gift_orders').findOne({ id: req.params.id })
  if (!giftOrder) return err('Gift order not found', 404)
  const customer  = await db.collection('users').findOne({ id: giftOrder.user_id })
  const { _id: _g1, ...cleanGiftOrder } = giftOrder
  const { _id: _g2, password: _g3, ...safeCustomer } = customer || {}
  return ok({ ...cleanGiftOrder, customer: safeCustomer })
}))

export default router
