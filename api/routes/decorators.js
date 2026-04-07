import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import crypto from 'crypto'
import { connectToMongo } from '../db.js'
import { hashPwd, sendWhatsApp, asyncRoute } from '../helpers.js'

const router = Router()

// ── Delivery Persons CRUD ──────────────────────────────────────

// GET /delivery-persons
router.get('/delivery-persons', asyncRoute(async (req, res, ok) => {
  const db  = await connectToMongo()
  const dps = await db.collection('delivery_persons').find({}).toArray()
  return ok(dps.map(({ _id, ...dp }) => dp))
}))

// POST /delivery-persons
router.post('/delivery-persons', asyncRoute(async (req, res, ok) => {
  const db   = await connectToMongo()
  const body = req.body
  const dp   = { id: uuidv4(), name: body.name, phone: body.phone || '', password: hashPwd(body.password || '1234'), is_active: true, current_location: null, schedule: {}, rating: 5.0, total_deliveries: 0, created_at: new Date() }
  await db.collection('delivery_persons').insertOne(dp)
  const { _id, password: _, ...clean } = dp
  return ok(clean)
}))

// PUT /delivery-persons/:id
router.put('/delivery-persons/:id', asyncRoute(async (req, res, ok, err) => {
  const db   = await connectToMongo()
  const body = req.body; delete body._id
  if (body.password) body.password = hashPwd(body.password)
  await db.collection('delivery_persons').updateOne({ id: req.params.id }, { $set: body })
  const dp = await db.collection('delivery_persons').findOne({ id: req.params.id })
  if (!dp) return err('Delivery person not found', 404)
  const { _id, password: _, ...clean } = dp
  return ok(clean)
}))

// DELETE /delivery-persons/:id
router.delete('/delivery-persons/:id', asyncRoute(async (req, res, ok) => {
  const db = await connectToMongo()
  await db.collection('delivery_persons').deleteOne({ id: req.params.id })
  return ok({ success: true })
}))

// ── Decorator App (dp/*) ───────────────────────────────────────

// POST /dp/login
router.post('/dp/login', asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const { phone, password } = req.body
  if (!phone) return err('Phone required')
  const dp = await db.collection('delivery_persons').findOne({ phone })
  if (!dp) return err('Delivery person not found', 404)
  if (dp.password && password && dp.password !== hashPwd(password)) return err('Invalid password', 401)
  const { _id, password: _, ...safe } = dp
  return ok(safe)
}))

// GET /dp/dashboard/:id
router.get('/dp/dashboard/:id', asyncRoute(async (req, res, ok, err) => {
  const db    = await connectToMongo()
  const dpId  = req.params.id
  const today = new Date().toISOString().split('T')[0]
  const dp    = await db.collection('delivery_persons').findOne({ id: dpId })
  if (!dp) return err('Delivery person not found', 404)
  const [todayOrders, allActiveOrders, pendingOrders, pendingGiftOrders] = await Promise.all([
    db.collection('orders').find({ $or: [{ accepted_decorators: dpId }, { delivery_person_id: dpId }], 'delivery_slot.date': today }).sort({ 'delivery_slot.hour': 1 }).toArray(),
    db.collection('orders').find({ $or: [{ accepted_decorators: dpId }, { delivery_person_id: dpId }], delivery_status: { $in: ['assigned','en_route','arrived','decorating'] } }).toArray(),
    db.collection('orders').find({ assigned_decorators: dpId, accepted_decorators: { $not: { $elemMatch: { $eq: dpId } } }, $expr: { $lt: [{ $size: { $ifNull: ['$accepted_decorators', []] } }, 2] } }).sort({ created_at: -1 }).toArray(),
    db.collection('gift_orders').find({ assigned_decorators: dpId, payment_status: 'full', delivery_status: 'pending' }).sort({ created_at: -1 }).toArray(),
  ])
  const { _id, password: _, ...safeDp } = dp
  return ok({ delivery_person: safeDp, today_orders: todayOrders.map(({ _id, ...o }) => o), active_orders: allActiveOrders.map(({ _id, ...o }) => o), pending_orders: pendingOrders.map(({ _id, ...o }) => o), pending_gift_orders: pendingGiftOrders.map(({ _id, ...o }) => o), date: today })
}))

// GET /dp/calendar/:id
router.get('/dp/calendar/:id', asyncRoute(async (req, res, ok, err) => {
  const db    = await connectToMongo()
  const dpId  = req.params.id
  const month = req.query.month || new Date().toISOString().slice(0, 7)
  const dp    = await db.collection('delivery_persons').findOne({ id: dpId })
  if (!dp) return err('Delivery person not found', 404)
  const orders = await db.collection('orders').find({ $or: [{ accepted_decorators: dpId }, { delivery_person_id: dpId }], 'delivery_slot.date': { $regex: `^${month}` } }).sort({ 'delivery_slot.date': 1, 'delivery_slot.hour': 1 }).toArray()
  return ok({ month, schedule: dp.schedule || {}, orders: orders.map(({ _id, ...o }) => o) })
}))

// GET /dp/orders/:id
router.get('/dp/orders/:id', asyncRoute(async (req, res, ok) => {
  const db    = await connectToMongo()
  const dpId  = req.params.id
  const query = { $or: [{ accepted_decorators: dpId }, { delivery_person_id: dpId }] }
  if (req.query.status) query.delivery_status = req.query.status
  const orders = await db.collection('orders').find(query).sort({ created_at: -1 }).toArray()
  return ok(orders.map(({ _id, ...o }) => o))
}))

// POST /dp/generate-otp
router.post('/dp/generate-otp', asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const { order_id } = req.body
  if (!order_id) return err('order_id required')
  const otp = String(Math.floor(1000 + Math.random() * 9000))
  await db.collection('orders').updateOne({ id: order_id }, { $set: { verification_otp: otp, otp_generated_at: new Date() } })
  return ok({ otp, order_id })
}))

// POST /dp/face-scan
router.post('/dp/face-scan', asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const { order_id, dp_id, face_image } = req.body
  if (!order_id || !dp_id || !face_image) return err('order_id, dp_id, face_image required')
  const dp    = await db.collection('delivery_persons').findOne({ id: dp_id })
  if (!dp) return err('Delivery person not found', 404)
  const order = await db.collection('orders').findOne({ id: order_id })
  if (!order) return err('Order not found', 404)
  const isAssigned = (order.accepted_decorators || []).includes(dp_id) || order.delivery_person_id === dp_id
  if (!isAssigned) return err('Not authorized for this order', 403)
  await db.collection('orders').updateOne({ id: order_id }, { $set: { face_scan: { dp_id, dp_name: dp.name, image: face_image, scanned_at: new Date() }, delivery_status: 'arrived' } })
  return ok({ success: true, dp_name: dp.name })
}))

// POST /dp/verify-otp
router.post('/dp/verify-otp', asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const { order_id, otp, dp_id } = req.body
  if (!order_id || !otp || !dp_id) return err('order_id, otp, dp_id required')
  const order = await db.collection('orders').findOne({ id: order_id })
  if (!order) return err('Order not found', 404)
  const isAssigned = (order.accepted_decorators || []).includes(dp_id) || order.delivery_person_id === dp_id
  if (!isAssigned) return err('Not authorized for this order', 403)
  if (!order.verification_otp) return err('OTP not yet generated', 400)
  const expected = Buffer.from(String(order.verification_otp))
  const actual   = Buffer.from(String(otp))
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return err('Invalid OTP', 401)
  const startTime = new Date()
  await db.collection('orders').updateOne({ id: order_id }, { $set: { delivery_status: 'decorating', decoration_started_at: startTime, otp_verified: true } })
  return ok({ success: true, started_at: startTime })
}))

// POST /dp/complete
router.post('/dp/complete', asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const { order_id, dp_id } = req.body
  if (!order_id || !dp_id) return err('order_id, dp_id required')
  const order = await db.collection('orders').findOne({ id: order_id })
  if (!order) return err('Order not found', 404)
  const isAssigned = (order.accepted_decorators || []).includes(dp_id) || order.delivery_person_id === dp_id
  if (!isAssigned) return err('Not authorized for this order', 403)
  const completedAt = new Date()
  await db.collection('orders').updateOne({ id: order_id }, { $set: { delivery_status: 'delivered', decoration_completed_at: completedAt } })
  await db.collection('delivery_persons').updateOne({ id: dp_id }, { $inc: { total_deliveries: 1 } })
  const doneUser = await db.collection('users').findOne({ id: order.user_id })
  if (doneUser?.phone) await sendWhatsApp(doneUser.phone, `FatafatDecor: Your decoration is complete! We hope you love it. Enjoy your celebration! Thank you for choosing FatafatDecor. -FatafatDecor`)
  return ok({ success: true, completed_at: completedAt })
}))

// POST /dp/collect-payment
router.post('/dp/collect-payment', asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const { order_id, dp_id, amount, method: payMethod, notes } = req.body
  if (!order_id || !dp_id || !amount) return err('order_id, dp_id, amount required')
  const order = await db.collection('orders').findOne({ id: order_id })
  if (!order) return err('Order not found', 404)
  const isAssigned = (order.accepted_decorators || []).includes(dp_id) || order.delivery_person_id === dp_id
  if (!isAssigned) return err('Not authorized for this order', 403)
  const collection = { id: uuidv4(), order_id, dp_id, amount: Number(amount), method: payMethod || 'cash', notes: notes || '', deposited: false, created_at: new Date() }
  await db.collection('dp_collections').insertOne(collection)
  await db.collection('orders').updateOne({ id: order_id }, { $set: { payment_status: 'full', remaining_collected: true, collection_method: payMethod || 'cash' } })
  const { _id, ...clean } = collection
  return ok(clean)
}))

// POST /dp/deposit-cash
router.post('/dp/deposit-cash', asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const { dp_id, amount, deposit_method, reference_number } = req.body
  if (!dp_id || !amount) return err('dp_id, amount required')
  const deposit = { id: uuidv4(), dp_id, amount: Number(amount), deposit_method: deposit_method || 'office_cash', reference_number: reference_number || '', created_at: new Date() }
  await db.collection('dp_deposits').insertOne(deposit)
  await db.collection('dp_collections').updateMany({ dp_id, deposited: false, method: 'cash' }, { $set: { deposited: true, deposit_id: deposit.id } })
  const { _id, ...clean } = deposit
  return ok(clean)
}))

// GET /dp/earnings/:id
router.get('/dp/earnings/:id', asyncRoute(async (req, res, ok) => {
  const db          = await connectToMongo()
  const dpId        = req.params.id
  const [collections, deposits] = await Promise.all([
    db.collection('dp_collections').find({ dp_id: dpId }).sort({ created_at: -1 }).toArray(),
    db.collection('dp_deposits').find({ dp_id: dpId }).sort({ created_at: -1 }).toArray(),
  ])
  const totalCollected = collections.reduce((s, c) => s + c.amount, 0)
  const cashCollected  = collections.filter(c => c.method === 'cash').reduce((s, c) => s + c.amount, 0)
  const cashDeposited  = deposits.reduce((s, d) => s + d.amount, 0)
  return ok({ total_collected: totalCollected, cash_collected: cashCollected, cash_deposited: cashDeposited, cash_pending: cashCollected - cashDeposited, recent_collections: collections.slice(0, 20).map(({ _id, ...c }) => c), recent_deposits: deposits.slice(0, 10).map(({ _id, ...d }) => d) })
}))

// POST /dp/update-status
router.post('/dp/update-status', asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const { order_id, status, notes, dp_id } = req.body
  if (!order_id || !status || !dp_id) return err('order_id, status, dp_id required')
  const order = await db.collection('orders').findOne({ id: order_id })
  if (!order) return err('Order not found', 404)
  const isAssigned = (order.accepted_decorators || []).includes(dp_id) || order.delivery_person_id === dp_id
  if (!isAssigned) return err('Not authorized for this order', 403)
  const update = { delivery_status: status }
  if (status === 'en_route') update.en_route_at = new Date()
  if (status === 'arrived')  update.arrived_at  = new Date()
  if (notes) update.dp_notes = notes
  await db.collection('orders').updateOne({ id: order_id }, { $set: update })
  const statusUser = await db.collection('users').findOne({ id: order.user_id })
  if (statusUser?.phone) {
    const msgs = {
      en_route:   'FatafatDecor: Great news! Your decorator is on the way to your location. Please be available. -FatafatDecor',
      arrived:    'FatafatDecor: Your decorator has arrived! Please open the door. Decoration will begin shortly. -FatafatDecor',
      decorating: 'FatafatDecor: Decoration work has started at your location! Sit back and relax. -FatafatDecor',
      delivered:  'FatafatDecor: Your decoration is complete! We hope you love it. Thank you for choosing FatafatDecor! -FatafatDecor',
    }
    if (msgs[status]) await sendWhatsApp(statusUser.phone, msgs[status])
  }
  return ok({ success: true })
}))

// GET /dp/order-detail/:id
router.get('/dp/order-detail/:id', asyncRoute(async (req, res, ok, err) => {
  const db     = await connectToMongo()
  const order  = await db.collection('orders').findOne({ id: req.params.id })
  if (!order) return err('Order not found', 404)
  const user   = await db.collection('users').findOne({ id: order.user_id })
  const design = order.design_id ? await db.collection('designs').findOne({ id: order.design_id }) : null
  let kitInfo  = null
  if (design?.kit_id) {
    const kit = await db.collection('decoration_kits').findOne({ id: design.kit_id })
    if (kit) { const { _id, reference_images, ...kitData } = kit; kitInfo = kitData }
  }
  const { _id: _1, password: _2, ...safeUser }   = user || {}
  const { _id: _3,               ...cleanOrder } = order
  return ok({ ...cleanOrder, customer: safeUser, decorated_image: design?.decorated_image || null, kit_name: design?.kit_name || null, kit_id: design?.kit_id || null, kit_info: kitInfo, kit_items: design?.kit_items || [], addon_items: design?.addon_items || [] })
}))

// POST /dp/accept-order
router.post('/dp/accept-order', asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const { order_id, dp_id } = req.body
  if (!order_id || !dp_id) return err('order_id and dp_id required')
  const dp    = await db.collection('delivery_persons').findOne({ id: dp_id })
  if (!dp) return err('Delivery person not found', 404)
  const order = await db.collection('orders').findOne({ id: order_id })
  if (!order) return err('Order not found', 404)
  if (!(order.assigned_decorators || []).includes(dp_id)) return err('Order not assigned to you', 403)
  if ((order.accepted_decorators || []).includes(dp_id)) return err('You have already accepted this order')
  const update = { $addToSet: { accepted_decorators: dp_id } }
  if (!order.delivery_person_id) update.$set = { delivery_person_id: dp_id, delivery_status: 'assigned' }
  await db.collection('orders').updateOne({ id: order_id }, update)
  return ok({ success: true, message: 'Order accepted successfully' })
}))

// POST /dp/decline-order
router.post('/dp/decline-order', asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const { order_id, dp_id } = req.body
  if (!order_id || !dp_id) return err('order_id and dp_id required')
  const order = await db.collection('orders').findOne({ id: order_id })
  if (!order) return err('Order not found', 404)
  await db.collection('orders').updateOne({ id: order_id }, { $pull: { assigned_decorators: dp_id, accepted_decorators: dp_id } })
  return ok({ success: true, message: 'Order declined' })
}))

export default router
