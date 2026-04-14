import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { connectToMongo } from '../db.js'
import { requireUser } from '../jwt.js'
import { sendWhatsApp, asyncRoute } from '../helpers.js'

const router = Router()

// POST /orders — requires JWT
router.post('/orders', requireUser, asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const body = req.body
  const user_id = req.userId // from JWT
  const { design_id, delivery_address, delivery_landmark, delivery_lat, delivery_lng, total_override, gift_items, gift_total } = body
  if (!design_id) return err('design_id required')

  const design = await db.collection('designs').findOne({ id: design_id })
  if (!design) return err('Design not found', 404)
  if (design.user_id && design.user_id !== user_id) return err('Design does not belong to this user', 403)

  // Reuse existing unpaid order for same design (prevents duplicates on payment retry)
  const existingOrder = await db.collection('orders').findOne({ design_id, user_id, payment_status: 'pending' })
  if (existingOrder) {
    const { _id, ...cleanExisting } = existingOrder
    return ok(cleanExisting)
  }

  // Validate total_override — allow down to 10% (user may remove most addon items)
  let finalTotal = design.total_cost
  if (total_override) {
    const overrideNum = Math.round(Number(total_override))
    const minAllowed  = Math.round(design.total_cost * 0.1)
    if (overrideNum < minAllowed || overrideNum > design.total_cost * 1.5) return err('Invalid total override amount', 400)
    finalTotal = overrideNum
  }

  const hasGifts           = Array.isArray(gift_items) && gift_items.length > 0
  const computedGiftTotal  = hasGifts ? gift_items.reduce((s, g) => s + (Number(g.price) || 0) * (Number(g.quantity) || 1), 0) : 0
  const orderTotal         = finalTotal + computedGiftTotal

  // Use items_override from client if user removed addon items, otherwise fall back to design items
  const orderItems = (Array.isArray(body.items_override) && body.items_override.length > 0) ? body.items_override : (design.items_used || [])

  const order = {
    id: uuidv4(), user_id, design_id,
    items: orderItems,
    total_cost: orderTotal, payment_status: 'pending', payment_amount: 0,
    delivery_person_id: null, delivery_slot: null, delivery_status: 'pending',
    delivery_address: delivery_address || '', delivery_landmark: delivery_landmark || '',
    delivery_location: { lat: delivery_lat || null, lng: delivery_lng || null },
    delivery_lat: delivery_lat || null, delivery_lng: delivery_lng || null,
    assigned_decorators: [], accepted_decorators: [],
    has_gifts: hasGifts, gift_items: hasGifts ? gift_items : [],
    gift_total: hasGifts ? (gift_total !== undefined ? Number(gift_total) : computedGiftTotal) : 0,
    created_at: new Date(),
  }
  await db.collection('orders').insertOne(order)

  // Assign all active decorators and notify them
  const availablePersons = await db.collection('delivery_persons').find({ is_active: true }).toArray()
  if (availablePersons.length > 0) {
    const assignedIds  = availablePersons.map(p => p.id)
    const assignedInfo = availablePersons.map(p => ({ id: p.id, name: p.name, phone: p.phone }))
    await db.collection('orders').updateOne({ id: order.id }, { $set: { assigned_decorators: assignedIds, assigned_decorators_info: assignedInfo } })
    order.assigned_decorators      = assignedIds
    order.assigned_decorators_info = assignedInfo
    for (const dp of availablePersons) {
      if (dp.phone) await sendWhatsApp(dp.phone, `FatafatDecor NEW ORDER #${order.id.slice(0, 8)}: ${order.delivery_address || 'Address not set'}. Amount: Rs.${order.total_cost}. Open your decorator app now to accept! -FatafatDecor`)
    }
  }
  // NOTE: Design status stays 'generated' until payment succeeds (prevents stuck designs on payment failure)
  const orderUser = await db.collection('users').findOne({ id: user_id })
  if (orderUser?.phone) await sendWhatsApp(orderUser.phone, `FatafatDecor: Your decoration order has been placed successfully! Total: Rs.${order.total_cost}. Decorators are being assigned. -FatafatDecor`)

  const { _id, ...clean } = order
  return ok(clean)
}))

// GET /orders — requires JWT, only returns own orders
router.get('/orders', requireUser, asyncRoute(async (req, res, ok) => {
  const db     = await connectToMongo()
  const orders = await db.collection('orders').find({ user_id: req.userId }).sort({ created_at: -1 }).limit(50).toArray()
  return ok(orders.map(({ _id, ...o }) => o))
}))

// GET /orders/:id — requires JWT, only returns own order
router.get('/orders/:id', requireUser, asyncRoute(async (req, res, ok, err) => {
  const db    = await connectToMongo()
  const order = await db.collection('orders').findOne({ id: req.params.id })
  if (!order) return err('Order not found', 404)
  if (order.user_id !== req.userId) return err('Not authorized', 403)
  const { _id, ...clean } = order
  return ok(clean)
}))

// POST /orders/:id/request-slot — requires JWT
router.post('/orders/:id/request-slot', requireUser, asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const { date, hour } = req.body
  if (!date || hour === undefined) return err('date and hour required')
  const order = await db.collection('orders').findOne({ id: req.params.id })
  if (!order) return err('Order not found', 404)
  if (order.user_id !== req.userId) return err('Not authorized', 403)
  await db.collection('orders').updateOne({ id: req.params.id }, { $set: { requested_slot: { date, hour }, delivery_status: 'pending' } })
  return ok({ success: true })
}))

// POST /orders/auto-reassign — requires JWT, only for own orders
router.post('/orders/auto-reassign', requireUser, asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const { order_id } = req.body
  if (!order_id) return err('order_id required')
  const order = await db.collection('orders').findOne({ id: order_id })
  if (!order) return err('Order not found', 404)
  if (order.user_id !== req.userId) return err('Not authorized', 403)
  if (order.delivery_status !== 'pending' && order.delivery_status !== 'assigned') return ok({ reassigned: false, reason: 'already progressed' })
  if (order.delivery_person_id) return ok({ reassigned: false, reason: 'decorator already assigned' })
  const ageMs = Date.now() - new Date(order.created_at).getTime()
  if (ageMs < 30 * 60 * 1000) return ok({ reassigned: false, reason: 'not timed out yet' })
  const availablePersons = await db.collection('delivery_persons').find({ is_active: true }).toArray()
  const currentIds       = order.assigned_decorators || []
  const fresh            = availablePersons.filter(p => !currentIds.includes(p.id)).slice(0, 2)
  const reassignedIds    = [...currentIds, ...fresh.map(p => p.id)]
  const reassignedInfo   = [...(order.assigned_decorators_info || []), ...fresh.map(p => ({ id: p.id, name: p.name, phone: p.phone }))]
  await db.collection('orders').updateOne({ id: order_id }, { $set: { assigned_decorators: reassignedIds, assigned_decorators_info: reassignedInfo, last_reassigned_at: new Date() } })
  const orderUser = await db.collection('users').findOne({ id: order.user_id })
  if (orderUser?.phone) await sendWhatsApp(orderUser.phone, `FatafatDecor: We are finding the best decorator for your order. Please wait a few more minutes. -FatafatDecor`)
  return ok({ reassigned: true, new_decorators: fresh.length })
}))

export default router
