import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { connectToMongo } from '../db.js'
import { requireUser } from '../jwt.js'
import { sendWhatsApp, asyncRoute } from '../helpers.js'
import { sendPushToDecorator } from '../push.js'

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

  // Reuse existing unpaid draft for the same design (prevents duplicate drafts on retry)
  const existingOrder = await db.collection('draft_orders').findOne({ design_id, user_id, payment_status: 'pending' })
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

  // Use items_override from client if user removed addon items, otherwise fall back to design items.
  // Reference-flow designs store items in design.snapshot.items; legacy kit-flow uses design.items_used.
  const isReferenceFlow = design.flow === 'reference' || !!design.reference_design_id
  const designItems = isReferenceFlow
    ? (design.snapshot?.items || [])
    : (design.items_used || [])
  const orderItems = (Array.isArray(body.items_override) && body.items_override.length > 0)
    ? body.items_override
    : designItems

  const order = {
    id: uuidv4(), user_id, design_id,
    items: orderItems,
    total_cost: orderTotal, payment_status: 'pending', payment_amount: 0,
    delivery_person_id: null, delivery_slot: null, delivery_status: 'awaiting_payment',
    delivery_address: delivery_address || '', delivery_landmark: delivery_landmark || '',
    delivery_location: { lat: delivery_lat || null, lng: delivery_lng || null },
    delivery_lat: delivery_lat || null, delivery_lng: delivery_lng || null,
    assigned_decorators: [], accepted_decorators: [],
    has_gifts: hasGifts, gift_items: hasGifts ? gift_items : [],
    gift_total: hasGifts ? computedGiftTotal : 0,
    // Reference-flow extras — decorator sees these, customer view doesn't
    flow: isReferenceFlow ? 'reference' : 'kit',
    reference_design_id:     design.reference_design_id     || null,
    reference_image_url:     design.reference_image_url     || null,
    reference_thumbnail_url: design.reference_thumbnail_url || null,
    original_image_url:      design.original_image_url      || null,
    decorated_image:         design.decorated_image          || null,
    customer_breakdown:      design.customer_breakdown       || null,
    completion_photos:       [],                              // filled by decorator on completion
    created_at: new Date(),
  }
  // Stored as a DRAFT until payment succeeds — keeps the `orders` collection free of
  // unpaid/abandoned rows. /payments/verify promotes it into `orders` once paid.
  // Decorators are assigned + notified only at that point.
  await db.collection('draft_orders').insertOne(order)

  const { _id, ...clean } = order
  return ok(clean)
}))

// GET /orders — requires JWT, only returns own orders
router.get('/orders', requireUser, asyncRoute(async (req, res, ok) => {
  const db = await connectToMongo()
  // Include the user's own unpaid draft so the order stays visible/resumable between
  // creation and payment. "Real order" lists filter payment_status:'pending' in the UI.
  const [paid, drafts] = await Promise.all([
    db.collection('orders').find({ user_id: req.userId }).sort({ created_at: -1 }).limit(50).toArray(),
    db.collection('draft_orders').find({ user_id: req.userId }).sort({ created_at: -1 }).limit(20).toArray(),
  ])
  // Prefer the paid copy if a draft + paid order briefly coexist for the same id (mid-promotion).
  const seen = new Set()
  const all = [...paid, ...drafts]
    .filter(o => (seen.has(o.id) ? false : seen.add(o.id)))
    .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
    .slice(0, 50)
  return ok(all.map(({ _id, ...o }) => o))
}))

// GET /orders/:id — requires JWT, only returns own order
router.get('/orders/:id', requireUser, asyncRoute(async (req, res, ok, err) => {
  const db    = await connectToMongo()
  const order = await db.collection('orders').findOne({ id: req.params.id })
    || await db.collection('draft_orders').findOne({ id: req.params.id })   // unpaid draft fallback
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
  for (const dp of fresh) {
    sendPushToDecorator(db, dp.id, {
      title: '🎉 New order available!',
      body: `A booking is waiting · Rs.${order.total_cost}. Tap to accept.`,
      tag: `fd-order-${order_id.slice(0, 8)}`,
      url: '/',
    }).catch(() => {})
  }
  const orderUser = await db.collection('users').findOne({ id: order.user_id })
  if (orderUser?.phone) await sendWhatsApp(orderUser.phone, `FatafatDecor: We are finding the best decorator for your order. Please wait a few more minutes. -FatafatDecor`)
  return ok({ reassigned: true, new_decorators: fresh.length })
}))

export default router
