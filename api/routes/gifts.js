import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { connectToMongo } from '../db.js'
import { requireUser, requireDp } from '../jwt.js'
import { asyncRoute } from '../helpers.js'

const router = Router()

// POST /gift-orders — requires JWT (with stock validation)
router.post('/gift-orders', requireUser, asyncRoute(async (req, res, ok, err) => {
  const db   = await connectToMongo()
  const user_id = req.userId
  const { delivery_address, delivery_landmark, delivery_lat, delivery_lng, gift_items, gift_message } = req.body
  if (!Array.isArray(gift_items) || gift_items.length === 0) return err('gift_items array required')
  if (!delivery_address || !String(delivery_address).trim()) return err('Delivery address is required', 400)

  // Validate stock + price every item from the catalog (never trust client-sent prices)
  const giftIds = gift_items.map(g => g.gift_id)
  const dbGifts = await db.collection('gifts').find({ id: { $in: giftIds } }).toArray()
  const giftMap = Object.fromEntries(dbGifts.map(g => [g.id, g]))
  const pricedItems = []
  for (const item of gift_items) {
    const dbGift = giftMap[item.gift_id]
    if (!dbGift) return err(`Gift "${item.name}" is no longer available`, 400)
    const qty = Math.max(1, Number(item.quantity) || 1)
    if (dbGift.stock !== undefined && dbGift.stock < qty)
      return err(`"${item.name}" has only ${dbGift.stock} left in stock`, 400)
    const price = Number(dbGift.price ?? dbGift.selling_price ?? item.price) || 0
    pricedItems.push({ ...item, quantity: qty, price })
  }
  const giftTotal = pricedItems.reduce((s, g) => s + g.price * g.quantity, 0)

  // Idempotency: reuse an identical unpaid gift order from the last 2 min (double-tap / retry)
  const sig = pricedItems.map(g => `${g.gift_id}:${g.quantity}`).sort().join('|')
  const recent = await db.collection('gift_orders').findOne(
    { user_id, payment_status: 'pending', created_at: { $gte: new Date(Date.now() - 2 * 60 * 1000) } },
    { sort: { created_at: -1 } },
  )
  if (recent) {
    const recentSig = (recent.gift_items || []).map(g => `${g.gift_id}:${g.quantity || 1}`).sort().join('|')
    if (recentSig === sig) { const { _id, ...clean } = recent; return ok(clean) }
  }

  const giftOrder = {
    id: uuidv4(), user_id, order_type: 'gift', gift_items: pricedItems, gift_total: giftTotal,
    gift_message: gift_message || '',
    delivery_address: delivery_address || '', delivery_landmark: delivery_landmark || '',
    delivery_location: { lat: delivery_lat || null, lng: delivery_lng || null },
    delivery_slot: null, payment_status: 'pending', payment_amount: 0,
    delivery_status: 'awaiting_payment', delivery_person_id: null,
    assigned_decorators: [], accepted_decorators: [], created_at: new Date(),
  }
  await db.collection('gift_orders').insertOne(giftOrder)
  // Stock is decremented only after payment is confirmed (in /payments/verify) so abandoned
  // gift orders never leak inventory.

  const { _id, ...clean } = giftOrder
  return ok(clean)
}))

// GET /gift-orders — requires JWT, only own orders
router.get('/gift-orders', requireUser, asyncRoute(async (req, res, ok) => {
  const db     = await connectToMongo()
  // Only paid gift orders — hide unpaid/abandoned drafts from the customer's gift list.
  const orders = await db.collection('gift_orders')
    .find({ user_id: req.userId, payment_status: { $ne: 'pending' } })
    .sort({ created_at: -1 }).limit(50).toArray()
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
  const { date, hour, gift_message, delivery_type } = req.body
  if (!date || hour === undefined) return err('date and hour required')
  const order = await db.collection('gift_orders').findOne({ id: req.params.id })
  if (!order) return err('Gift order not found', 404)
  if (order.user_id !== req.userId) return err('Not authorized', 403)
  if (order.payment_status !== 'full') return err('Gift order must be paid before booking a slot', 402)
  const setFields = { requested_slot: { date, hour }, delivery_slot: { date, hour } }
  if (typeof gift_message === 'string') setFields.gift_message = gift_message.slice(0, 500)
  if (delivery_type === 'instant' || delivery_type === 'scheduled') setFields.delivery_type = delivery_type
  await db.collection('gift_orders').updateOne({ id: req.params.id }, { $set: setFields })
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
