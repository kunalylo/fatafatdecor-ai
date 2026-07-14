import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import crypto from 'crypto'
import { connectToMongo } from '../db.js'
import { hashPwd, sendWhatsApp, sendOtpSms, sendVerificationOtpEmail, asyncRoute, isCityAllowed, normalizeCityName, matchAllowedCityInText, decoratorCommitments, scheduleConflictAgainst, scheduleClashMessage, conflictDescriptor } from '../helpers.js'
import { signToken, requireDp, requireAdmin } from '../jwt.js'
import { VAPID_PUBLIC_KEY, RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET } from '../config.js'
import Razorpay from 'razorpay'

const router = Router()

// ── Delivery Persons CRUD (admin only — guarded by admin router in practice) ───
// Note: these endpoints are meant for admin use. Do NOT mount them on public paths
// without an admin check in the parent router.

// GET /delivery-persons — admin only
router.get('/delivery-persons', requireAdmin, asyncRoute(async (req, res, ok) => {
  const db  = await connectToMongo()
  const dps = await db.collection('delivery_persons').find({}).toArray()
  return ok(dps.map(({ _id, password: _, ...dp }) => dp))
}))

// POST /delivery-persons — admin only
router.post('/delivery-persons', requireAdmin, asyncRoute(async (req, res, ok) => {
  const db   = await connectToMongo()
  const body = req.body
  const dp   = { id: uuidv4(), name: body.name, phone: body.phone || '', password: hashPwd(body.password || '1234'), is_active: true, current_location: null, schedule: {}, rating: 5.0, total_deliveries: 0, created_at: new Date() }
  await db.collection('delivery_persons').insertOne(dp)
  const { _id, password: _, ...clean } = dp
  return ok(clean)
}))

// PUT /delivery-persons/:id — admin only
router.put('/delivery-persons/:id', requireAdmin, asyncRoute(async (req, res, ok, err) => {
  const db   = await connectToMongo()
  const body = req.body; delete body._id; delete body.id
  if (body.password) body.password = hashPwd(body.password)
  await db.collection('delivery_persons').updateOne({ id: req.params.id }, { $set: body })
  const dp = await db.collection('delivery_persons').findOne({ id: req.params.id })
  if (!dp) return err('Delivery person not found', 404)
  const { _id, password: _, ...clean } = dp
  return ok(clean)
}))

// DELETE /delivery-persons/:id — admin only
router.delete('/delivery-persons/:id', requireAdmin, asyncRoute(async (req, res, ok) => {
  const db = await connectToMongo()
  await db.collection('delivery_persons').deleteOne({ id: req.params.id })
  return ok({ success: true })
}))

// ── Decorator App (dp/*) ───────────────────────────────────────
// Helper: make sure the authenticated decorator (req.dpId) is actually
// assigned to the given order. Returns the order or sends 403/404 itself.
async function assertDpOwnsOrder(db, orderId, dpId, res) {
  const order = await db.collection('orders').findOne({ id: orderId })
  if (!order) { res.status(404).json({ error: 'Order not found' }); return null }
  const isAssigned =
    (order.accepted_decorators || []).includes(dpId) ||
    (order.assigned_decorators || []).includes(dpId) ||
    order.delivery_person_id === dpId
  if (!isAssigned) { res.status(403).json({ error: 'Not authorized for this order' }); return null }
  return order
}

// POST /dp/login — issues JWT
router.post('/dp/login', asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const { phone, password } = req.body
  if (!phone) return err('Phone required')
  const cleanPhone = String(phone).replace(/\D/g, '').slice(-10)
  if (cleanPhone.length !== 10) return err('Enter a valid 10-digit phone number')
  const dp = await db.collection('delivery_persons').findOne({
    $or: [{ phone }, { phone: cleanPhone }]
  })
  if (!dp) return err('Delivery person not found', 404)
  // If the decorator has a password set, it MUST be provided and match. (Previously an empty
  // password skipped the check entirely — anyone knowing the phone could log in.)
  if (dp.password && (!password || dp.password !== hashPwd(password))) return err('Invalid password', 401)
  if (dp.is_active === false) return err('Account is inactive. Contact support.', 403)
  const token = await signToken({ dp_id: dp.id, role: 'decorator' })
  const { _id, password: _, ...safe } = dp
  return ok({ ...safe, token })
}))

// GET /dp/me — refresh current decorator profile (also doubles as "token still valid?")
router.get('/dp/me', requireDp, asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const dp = await db.collection('delivery_persons').findOne({ id: req.dpId })
  if (!dp) return err('Decorator not found', 404)
  if (dp.is_active === false) return err('Account is inactive', 403)
  const { _id, password: _, ...safe } = dp
  return ok(safe)
}))

// POST /dp/change-password
router.post('/dp/change-password', requireDp, asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const { current_password, new_password } = req.body
  if (!current_password || !new_password) return err('current_password and new_password required')
  if (String(new_password).length < 4) return err('New password must be at least 4 characters', 400)
  const dp = await db.collection('delivery_persons').findOne({ id: req.dpId })
  if (!dp) return err('Decorator not found', 404)
  if (dp.password && dp.password !== hashPwd(current_password)) return err('Current password is incorrect', 401)
  await db.collection('delivery_persons').updateOne(
    { id: req.dpId },
    { $set: { password: hashPwd(new_password), password_changed_at: new Date() } }
  )
  return ok({ success: true, message: 'Password updated successfully' })
}))

// POST /dp/update-city — decorator sets the city they currently work in.
// They only receive orders/notifications from this city. Must be a city we serve.
router.post('/dp/update-city', requireDp, asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const { city } = req.body
  if (!city || !String(city).trim()) return err('city required')
  const normalized = normalizeCityName(String(city).trim())
  if (!(await isCityAllowed(db, normalized))) return err('We do not serve that city yet. Pick a city from the list.', 400)
  await db.collection('delivery_persons').updateOne(
    { id: req.dpId },
    { $set: { city: normalized, city_updated_at: new Date() } }
  )
  const dp = await db.collection('delivery_persons').findOne({ id: req.dpId })
  const { _id, password: _, ...safe } = dp || {}
  return ok({ success: true, city: normalized, decorator: safe })
}))

// POST /dp/detect-city — set the decorator's city from their CURRENT GPS location.
// Client sends { lat, lng, address } where address is the reverse-geocoded place text.
// We pick the served city that appears in that text (so a decorator physically in Pune can
// never be matched to a Ranchi order). Also stores the live location. `served` tells the app
// whether the detected city is one we operate in.
router.post('/dp/detect-city', requireDp, asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const { lat, lng, address, city } = req.body || {}
  let resolved = await matchAllowedCityInText(db, address)   // prefer an allowed city found in the geocode text
  let served = !!resolved
  if (!resolved && city) {                                    // fall back to the raw detected city name
    resolved = normalizeCityName(String(city).trim())
    served = await isCityAllowed(db, resolved)
  }
  const set = { city_updated_at: new Date(), city_auto: true }
  if (resolved) set.city = resolved
  if (lat != null && lng != null) set.current_location = { lat, lng, updated_at: new Date() }
  await db.collection('delivery_persons').updateOne({ id: req.dpId }, { $set: set })
  return ok({ success: true, city: resolved || null, served })
}))

// GET /dp/dashboard/:id
router.get('/dp/dashboard/:id', requireDp, asyncRoute(async (req, res, ok, err) => {
  const db    = await connectToMongo()
  const dpId  = req.dpId // from JWT, ignore :id
  if (req.params.id !== dpId) return err('Forbidden', 403)
  const today = new Date().toISOString().split('T')[0]
  const dp    = await db.collection('delivery_persons').findOne({ id: dpId })
  if (!dp) return err('Delivery person not found', 404)
  const [todayOrders, allActiveOrders, pendingOrders, pendingGiftOrders, activeGiftOrders] = await Promise.all([
    db.collection('orders').find({ $or: [{ accepted_decorators: dpId }, { delivery_person_id: dpId }], 'delivery_slot.date': today }).sort({ 'delivery_slot.hour': 1 }).toArray(),
    db.collection('orders').find({ $or: [{ accepted_decorators: dpId }, { delivery_person_id: dpId }], delivery_status: { $in: ['assigned','en_route','arrived','decorating'] } }).toArray(),
    db.collection('orders').find({ assigned_decorators: dpId, accepted_decorators: { $not: { $elemMatch: { $eq: dpId } } }, $expr: { $lt: [{ $size: { $ifNull: ['$accepted_decorators', []] } }, 2] } }).sort({ created_at: -1 }).toArray(),
    db.collection('gift_orders').find({ assigned_decorators: dpId, payment_status: 'full', delivery_status: 'pending' }).sort({ created_at: -1 }).toArray(),
    // Accepted gift orders still in progress — so the decorator can re-open them to finish the OTP/hand-over.
    db.collection('gift_orders').find({ $or: [{ accepted_decorators: dpId }, { delivery_person_id: dpId }], delivery_status: { $in: ['assigned','en_route','arrived'] } }).sort({ created_at: -1 }).toArray(),
  ])
  const { _id, password: _, ...safeDp } = dp
  // Flag pending orders that clash with what this decorator has already accepted, so the app can
  // disable Accept and explain why (double-booking: each job needs a 30m+2h+30m clear block).
  const commitments = await decoratorCommitments(db, dpId)
  const withConflict = (o, kind) => ({ ...o, schedule_conflict: conflictDescriptor(scheduleConflictAgainst(commitments, o.delivery_slot, kind, o.id)) })
  return ok({ delivery_person: safeDp, today_orders: todayOrders.map(({ _id, ...o }) => o), active_orders: allActiveOrders.map(({ _id, ...o }) => o), pending_orders: pendingOrders.map(({ _id, ...o }) => withConflict(o, 'decoration')), pending_gift_orders: pendingGiftOrders.map(({ _id, ...o }) => withConflict(o, 'gift')), active_gift_orders: activeGiftOrders.map(({ _id, ...o }) => o), date: today })
}))

// GET /dp/calendar/:id
router.get('/dp/calendar/:id', requireDp, asyncRoute(async (req, res, ok, err) => {
  const db    = await connectToMongo()
  const dpId  = req.dpId
  if (req.params.id !== dpId) return err('Forbidden', 403)
  const month = req.query.month || new Date().toISOString().slice(0, 7)
  if (!/^\d{4}-\d{2}$/.test(month)) return err('Invalid month format. Use YYYY-MM', 400)
  const dp    = await db.collection('delivery_persons').findOne({ id: dpId })
  if (!dp) return err('Delivery person not found', 404)
  const orders = await db.collection('orders').find({ $or: [{ accepted_decorators: dpId }, { delivery_person_id: dpId }], 'delivery_slot.date': { $regex: `^${month}` } }).sort({ 'delivery_slot.date': 1, 'delivery_slot.hour': 1 }).toArray()
  return ok({ month, schedule: dp.schedule || {}, orders: orders.map(({ _id, ...o }) => o) })
}))

// GET /dp/orders/:id
router.get('/dp/orders/:id', requireDp, asyncRoute(async (req, res, ok, err) => {
  const db    = await connectToMongo()
  const dpId  = req.dpId
  if (req.params.id !== dpId) return err('Forbidden', 403)
  const query = { $or: [{ accepted_decorators: dpId }, { delivery_person_id: dpId }] }
  if (req.query.status) query.delivery_status = req.query.status
  const orders = await db.collection('orders').find(query).sort({ created_at: -1 }).toArray()
  return ok(orders.map(({ _id, ...o }) => o))
}))

// POST /dp/generate-otp
router.post('/dp/generate-otp', requireDp, asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const dpId = req.dpId
  const { order_id } = req.body
  if (!order_id) return err('order_id required')
  const order = await assertDpOwnsOrder(db, order_id, dpId, res)
  if (!order) return
  // 6-digit OTP (upgraded from 4-digit; still accepted but harder to brute-force)
  const otp = String(Math.floor(100000 + Math.random() * 900000))
  await db.collection('orders').updateOne(
    { id: order_id },
    { $set: { verification_otp: otp, otp_generated_at: new Date() } }
  )
  // Notify customer with their OTP via SMS + Email (replaces WhatsApp)
  const customer = await db.collection('users').findOne({ id: order.user_id })
  if (customer?.phone) sendOtpSms(customer.phone, otp)
  if (customer?.email) sendVerificationOtpEmail(customer.name, customer.email, otp, order_id)
  return ok({ success: true, order_id })
}))

// POST /dp/selfie-proof — (formerly "face-scan"; now just a check-in photo)
// This is NOT biometric verification — it is a selfie proof that the decorator
// is physically at the customer's location, uploaded for record/audit purposes.
router.post('/dp/selfie-proof', requireDp, asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const dpId = req.dpId
  const { order_id, selfie_image, face_image, lat, lng } = req.body
  const image = selfie_image || face_image // accept both keys for backward compat
  if (!order_id || !image) return err('order_id and selfie_image required')
  const dp = await db.collection('delivery_persons').findOne({ id: dpId })
  if (!dp) return err('Decorator not found', 404)
  const order = await assertDpOwnsOrder(db, order_id, dpId, res)
  if (!order) return
  // Check-in only makes sense once the decorator is on the way (en_route) — Start Navigation is
  // also where the customer OTP is issued, so block skipping straight to "arrived".
  if (!['en_route', 'arrived'].includes(order.delivery_status)) return err('Start navigation before checking in', 400)
  await db.collection('orders').updateOne(
    { id: order_id },
    { $set: {
        selfie_proof: {
          dp_id: dpId,
          dp_name: dp.name,
          image,
          location: (lat && lng) ? { lat, lng } : null,
          captured_at: new Date()
        },
        // keep `face_scan` key populated too, so old clients still see "done"
        face_scan: { dp_id: dpId, dp_name: dp.name, image, scanned_at: new Date() },
        delivery_status: 'arrived',
        arrived_at: new Date()
    } }
  )
  return ok({ success: true, dp_name: dp.name })
}))

// POST /dp/face-scan — legacy alias, forwards to selfie-proof behavior
router.post('/dp/face-scan', requireDp, asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const dpId = req.dpId
  const { order_id, face_image } = req.body
  if (!order_id || !face_image) return err('order_id and face_image required')
  const dp = await db.collection('delivery_persons').findOne({ id: dpId })
  if (!dp) return err('Decorator not found', 404)
  const order = await assertDpOwnsOrder(db, order_id, dpId, res)
  if (!order) return
  await db.collection('orders').updateOne(
    { id: order_id },
    { $set: {
        selfie_proof: { dp_id: dpId, dp_name: dp.name, image: face_image, captured_at: new Date() },
        face_scan:    { dp_id: dpId, dp_name: dp.name, image: face_image, scanned_at: new Date() },
        delivery_status: 'arrived',
        arrived_at: new Date()
    } }
  )
  return ok({ success: true, dp_name: dp.name })
}))

// POST /dp/verify-otp
router.post('/dp/verify-otp', requireDp, asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const dpId = req.dpId
  const { order_id, otp } = req.body
  if (!order_id || !otp) return err('order_id and otp required')
  const order = await assertDpOwnsOrder(db, order_id, dpId, res)
  if (!order) return
  if (!order.verification_otp) return err('OTP not yet generated', 400)
  // Rate limit: max 5 wrong attempts within 10 minutes per order
  const attempts  = order.otp_attempts || 0
  const firstTry  = order.otp_first_attempt_at ? new Date(order.otp_first_attempt_at).getTime() : 0
  const withinTen = firstTry && (Date.now() - firstTry) < 10 * 60 * 1000
  if (attempts >= 5 && withinTen) return err('Too many attempts. Try again in 10 minutes.', 429)
  const expected = Buffer.from(String(order.verification_otp))
  const actual   = Buffer.from(String(otp))
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    await db.collection('orders').updateOne(
      { id: order_id },
      { $inc: { otp_attempts: 1 }, $set: { otp_first_attempt_at: order.otp_first_attempt_at || new Date() } }
    )
    return err('Invalid OTP', 401)
  }
  const startTime = new Date()
  await db.collection('orders').updateOne(
    { id: order_id },
    { $set: { delivery_status: 'decorating', decoration_started_at: startTime, otp_verified: true },
      $unset: { otp_attempts: '', otp_first_attempt_at: '' } }
  )
  return ok({ success: true, started_at: startTime })
}))

// POST /dp/complete
router.post('/dp/complete', requireDp, asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const dpId = req.dpId
  const { order_id } = req.body
  if (!order_id) return err('order_id required')
  const order = await assertDpOwnsOrder(db, order_id, dpId, res)
  if (!order) return
  const completedAt = new Date()
  await db.collection('orders').updateOne(
    { id: order_id },
    { $set: { delivery_status: 'delivered', decoration_completed_at: completedAt } }
  )
  await db.collection('delivery_persons').updateOne({ id: dpId }, { $inc: { total_deliveries: 1 } })
  const doneUser = await db.collection('users').findOne({ id: order.user_id })
  if (doneUser?.phone) await sendWhatsApp(doneUser.phone, `FatafatDecor: Your decoration is complete! We hope you love it. Enjoy your celebration! Thank you for choosing FatafatDecor. -FatafatDecor`)
  return ok({ success: true, completed_at: completedAt })
}))

// POST /dp/completion-photos — decorator uploads photos of the finished work.
// Body: { order_id, photos: [base64 data URLs] }  — max 6 photos per call.
// Persists URLs on order.completion_photos[]. Visible to customer + admin.
router.post('/dp/completion-photos', requireDp, asyncRoute(async (req, res, ok, err) => {
  const db   = await connectToMongo()
  const dpId = req.dpId
  const { order_id, photos } = req.body || {}
  if (!order_id) return err('order_id required')
  if (!Array.isArray(photos) || photos.length === 0) return err('photos[] required')
  if (photos.length > 6) return err('Max 6 photos per upload', 400)

  const order = await assertDpOwnsOrder(db, order_id, dpId, res)
  if (!order) return

  const { IMAGEKIT_PRIVATE_KEY } = await import('../config.js')
  if (!IMAGEKIT_PRIVATE_KEY) return err('Image storage not configured', 500)
  const ikAuth = Buffer.from(IMAGEKIT_PRIVATE_KEY + ':').toString('base64')

  const existing = Array.isArray(order.completion_photos) ? order.completion_photos : []
  const uploaded = []

  for (let i = 0; i < photos.length; i++) {
    try {
      const raw = String(photos[i] || '')
      const b64 = raw.startsWith('data:') ? raw.split(',')[1] : raw
      if (!b64) continue
      const idx = existing.length + uploaded.length + 1
      const ikBody = new URLSearchParams()
      ikBody.append('file', b64)
      ikBody.append('fileName', `completion_${order_id.slice(0, 8)}_${idx}_${Date.now()}.jpg`)
      ikBody.append('folder', '/completion')
      const ikRes = await fetch('https://upload.imagekit.io/api/v1/files/upload', {
        method: 'POST',
        headers: { 'Authorization': `Basic ${ikAuth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: ikBody.toString(),
      })
      const ikData = await ikRes.json()
      if (ikData.url) {
        uploaded.push({
          url: ikData.url,
          file_id: ikData.fileId || null,
          uploaded_by: dpId,
          uploaded_at: new Date(),
        })
      }
    } catch (e) {
      console.warn('[completion-photos] upload failed:', e.message)
    }
  }

  if (uploaded.length === 0) return err('All uploads failed. Please try again.', 500)

  await db.collection('orders').updateOne(
    { id: order_id },
    { $push: { completion_photos: { $each: uploaded } } },
  )

  return ok({
    success: true,
    uploaded: uploaded.length,
    total:    existing.length + uploaded.length,
    photos:   uploaded,
  })
}))

// DELETE /dp/completion-photos/:order_id/:index — remove a completion photo by index
router.delete('/dp/completion-photos/:order_id/:index', requireDp, asyncRoute(async (req, res, ok, err) => {
  const db   = await connectToMongo()
  const dpId = req.dpId
  const idx  = parseInt(req.params.index, 10)
  if (!Number.isInteger(idx) || idx < 0) return err('Invalid index', 400)

  const order = await assertDpOwnsOrder(db, req.params.order_id, dpId, res)
  if (!order) return
  const photos = Array.isArray(order.completion_photos) ? [...order.completion_photos] : []
  if (idx >= photos.length) return err('Photo index out of range', 404)
  photos.splice(idx, 1)
  await db.collection('orders').updateOne({ id: req.params.order_id }, { $set: { completion_photos: photos } })
  return ok({ success: true, total: photos.length })
}))

// POST /dp/collect-payment
router.post('/dp/collect-payment', requireDp, asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const dpId = req.dpId
  const { order_id, amount, method: payMethod, notes } = req.body
  if (!order_id || amount === undefined) return err('order_id and amount required')
  const amt = Number(amount)
  if (!Number.isFinite(amt) || amt <= 0) return err('Invalid amount', 400)
  const order = await assertDpOwnsOrder(db, order_id, dpId, res)
  if (!order) return
  // Guard against double-collection (the online path already does this).
  if (order.payment_status === 'full') return err('This order is already fully paid', 400)
  const collection = { id: uuidv4(), order_id, dp_id: dpId, amount: amt, method: payMethod || 'cash', notes: notes || '', deposited: false, created_at: new Date() }
  await db.collection('dp_collections').insertOne(collection)
  await db.collection('orders').updateOne(
    { id: order_id },
    { $set: { payment_status: 'full', remaining_collected: true, collection_method: payMethod || 'cash' }, $inc: { payment_amount: amt } }
  )
  const { _id, ...clean } = collection
  return ok(clean)
}))

// POST /dp/collect-payment/create-online — start a real online payment for the
// remaining balance. Decorator-initiated; customer pays via Razorpay (UPI/card/QR).
router.post('/dp/collect-payment/create-online', requireDp, asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const dpId = req.dpId
  const { order_id } = req.body
  if (!order_id) return err('order_id required')
  const order = await assertDpOwnsOrder(db, order_id, dpId, res)
  if (!order) return
  if (order.payment_status === 'full') return err('Order already fully paid', 400)
  const remaining = Math.round((order.total_cost || 0) - (order.payment_amount || 0))
  if (remaining <= 0) return err('Nothing remaining to collect', 400)
  const rzp = new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET })
  const rzpOrder = await rzp.orders.create({ amount: remaining * 100, currency: 'INR', receipt: `dpcol_${order_id.slice(0, 8)}` })
  const payment = { id: uuidv4(), type: 'dp_collection', user_id: order.user_id, dp_id: dpId, order_id, amount: remaining, razorpay_order_id: rzpOrder.id, status: 'created', created_at: new Date() }
  await db.collection('payments').insertOne(payment)
  return ok({ razorpay_order_id: rzpOrder.id, amount: rzpOrder.amount, currency: 'INR', payment_id: payment.id, razorpay_key_id: RAZORPAY_KEY_ID, remaining })
}))

// POST /dp/collect-payment/verify-online — verify Razorpay signature, mark order paid
router.post('/dp/collect-payment/verify-online', requireDp, asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const dpId = req.dpId
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) return err('Missing payment fields', 400)
  const expected = crypto.createHmac('sha256', RAZORPAY_KEY_SECRET).update(razorpay_order_id + '|' + razorpay_payment_id).digest('hex')
  if (expected !== razorpay_signature) return err('Payment verification failed', 400)
  const payment = await db.collection('payments').findOne({ razorpay_order_id })
  if (!payment) return err('Payment not found', 404)
  if (payment.dp_id !== dpId) return err('Not authorized', 403)
  const order = await assertDpOwnsOrder(db, payment.order_id, dpId, res)
  if (!order) return
  if (payment.status !== 'verified') {
    await db.collection('payments').updateOne(
      { razorpay_order_id },
      { $set: { status: 'verified', razorpay_payment_id, razorpay_signature, verified_at: new Date() } }
    )
    // Online → money goes straight to the company, so mark deposited:true (never counts as cash-to-deposit)
    await db.collection('dp_collections').insertOne({ id: uuidv4(), order_id: payment.order_id, dp_id: dpId, amount: payment.amount, method: 'online', deposited: true, razorpay_payment_id, created_at: new Date() })
    await db.collection('orders').updateOne(
      { id: payment.order_id },
      { $set: { payment_status: 'full', remaining_collected: true, collection_method: 'online' }, $inc: { payment_amount: payment.amount } }
    )
  }
  return ok({ success: true })
}))

// POST /dp/deposit-cash
router.post('/dp/deposit-cash', requireDp, asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const dpId = req.dpId
  const { amount, deposit_method, reference_number } = req.body
  if (amount === undefined) return err('amount required')
  const amt = Number(amount)
  if (!Number.isFinite(amt) || amt <= 0) return err('Invalid amount', 400)
  const deposit = { id: uuidv4(), dp_id: dpId, amount: amt, deposit_method: deposit_method || 'office_cash', reference_number: reference_number || '', created_at: new Date() }
  await db.collection('dp_deposits').insertOne(deposit)
  await db.collection('dp_collections').updateMany(
    { dp_id: dpId, deposited: false, method: 'cash' },
    { $set: { deposited: true, deposit_id: deposit.id } }
  )
  const { _id, ...clean } = deposit
  return ok(clean)
}))

// GET /dp/earnings/:id
router.get('/dp/earnings/:id', requireDp, asyncRoute(async (req, res, ok, err) => {
  const db   = await connectToMongo()
  const dpId = req.dpId
  if (req.params.id !== dpId) return err('Forbidden', 403)
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
router.post('/dp/update-status', requireDp, asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const dpId = req.dpId
  const { order_id, status, notes } = req.body
  if (!order_id || !status) return err('order_id and status required')
  // 'decorating' and 'delivered' are NOT settable here — they require the customer OTP
  // (dp/verify-otp) and completion (dp/complete) flows. Blocking them here stops the OTP
  // check-in from being bypassed via a plain status update.
  if (status === 'decorating') return err('Verify the customer OTP to start decorating', 400)
  if (status === 'delivered')  return err('Use Complete to finish the job', 400)
  const VALID = ['pending','assigned','en_route','arrived','cancelled']
  if (!VALID.includes(status)) return err('Invalid status', 400)
  const order = await assertDpOwnsOrder(db, order_id, dpId, res)
  if (!order) return
  // Enforce valid status transitions
  const TRANSITIONS = {
    pending: ['assigned','cancelled'], assigned: ['en_route','cancelled'],
    en_route: ['arrived','cancelled'], arrived: ['cancelled'],
    decorating: [], delivered: [], cancelled: [],
  }
  const allowed = TRANSITIONS[order.delivery_status || 'pending'] || []
  if (!allowed.includes(status)) return err(`Cannot move from "${order.delivery_status || 'pending'}" to "${status}"`, 400)
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
router.get('/dp/order-detail/:id', requireDp, asyncRoute(async (req, res, ok, err) => {
  const db     = await connectToMongo()
  const dpId   = req.dpId
  const order  = await db.collection('orders').findOne({ id: req.params.id })
  if (!order) return err('Order not found', 404)
  const isAssigned =
    (order.accepted_decorators || []).includes(dpId) ||
    (order.assigned_decorators || []).includes(dpId) ||
    order.delivery_person_id === dpId
  if (!isAssigned) return err('Not authorized for this order', 403)
  const user   = await db.collection('users').findOne({ id: order.user_id })
  const design = order.design_id ? await db.collection('designs').findOne({ id: order.design_id }) : null
  let kitInfo  = null
  if (design?.kit_id) {
    const kit = await db.collection('decoration_kits').findOne({ id: design.kit_id })
    if (kit) { const { _id, reference_images, ...kitData } = kit; kitInfo = kitData }
  }
  const { _id: _1, password: _2, ...safeUser }   = user || {}
  const { _id: _3,               ...cleanOrder } = order

  // Enrich procurement items with their SKU's product image — the decorator
  // should see WHAT each item looks like, not decode SKU codes.
  if (Array.isArray(cleanOrder.items) && cleanOrder.items.length > 0) {
    const codes = [...new Set(cleanOrder.items.map(i => i.matched_sku_code).filter(Boolean))]
    if (codes.length > 0) {
      const skus = await db.collection('master_inventory')
        .find({ sku_code: { $in: codes } })
        .project({ sku_code: 1, image_url: 1 })
        .toArray()
      const imgBySku = Object.fromEntries(skus.map(s => [s.sku_code, s.image_url || null]))
      cleanOrder.items = cleanOrder.items.map(i => ({
        ...i,
        item_image_url: i.matched_sku_code ? (imgBySku[i.matched_sku_code] || null) : null,
      }))
    }
  }

  return ok({ ...cleanOrder, customer: safeUser, decorated_image: design?.decorated_image || null, kit_name: design?.kit_name || null, kit_id: design?.kit_id || null, kit_info: kitInfo, kit_items: design?.kit_items || [], addon_items: design?.addon_items || [] })
}))

// POST /dp/accept-order
router.post('/dp/accept-order', requireDp, asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const dpId = req.dpId
  const { order_id } = req.body
  if (!order_id) return err('order_id required')
  const dp    = await db.collection('delivery_persons').findOne({ id: dpId })
  if (!dp) return err('Decorator not found', 404)
  const order = await db.collection('orders').findOne({ id: order_id })
  if (!order) return err('Order not found', 404)
  if (!(order.assigned_decorators || []).includes(dpId)) return err('Order not assigned to you', 403)
  if ((order.accepted_decorators || []).includes(dpId)) return err('You have already accepted this order')
  if ((order.accepted_decorators || []).length >= 2) return err('This order already has 2 decorators assigned', 409)
  // Double-booking guard: this job's 3-hour block (30 min travel + 2 h decorate + 30 min return)
  // must not overlap any job the decorator has already committed to.
  const commitments = await decoratorCommitments(db, dpId)
  const clash = scheduleConflictAgainst(commitments, order.delivery_slot, 'decoration', order_id)
  if (clash) return err(scheduleClashMessage(clash), 409)
  // Atomic accept — the filter only matches while fewer than 2 have accepted, so two decorators
  // accepting at the same instant can never push past the cap (the read above can be stale).
  const r = await db.collection('orders').updateOne(
    { id: order_id, $expr: { $lt: [{ $size: { $ifNull: ['$accepted_decorators', []] } }, 2] } },
    { $addToSet: { accepted_decorators: dpId } }
  )
  if (r.matchedCount === 0) return err('This order already has 2 decorators assigned', 409)
  // First accepter becomes the lead decorator (for live tracking) — set only if still unset.
  await db.collection('orders').updateOne(
    { id: order_id, $or: [{ delivery_person_id: null }, { delivery_person_id: { $exists: false } }] },
    { $set: { delivery_person_id: dpId, delivery_status: 'assigned' } }
  )
  // Close the concurrent-accept race: two accepts tapped at the same moment can both pass the
  // pre-check before either write lands. Re-check AFTER writing; if this accept now overlaps
  // another commitment, roll it back and reject.
  const afterCommitments = await decoratorCommitments(db, dpId)
  const postClash = scheduleConflictAgainst(afterCommitments, order.delivery_slot, 'decoration', order_id)
  if (postClash) {
    await db.collection('orders').updateOne({ id: order_id }, { $pull: { accepted_decorators: dpId } })
    await db.collection('orders').updateOne(
      { id: order_id, delivery_person_id: dpId },
      { $set: { delivery_person_id: null, delivery_status: 'pending' } }
    )
    return err(scheduleClashMessage(postClash), 409)
  }
  return ok({ success: true, message: 'Order accepted successfully' })
}))

// ── Web Push (decorator notifications) ──────────────────────────
// Public: the decorator app fetches the VAPID public key before subscribing.
router.get('/push/vapid-public-key', asyncRoute(async (req, res, ok) => {
  return ok({ public_key: VAPID_PUBLIC_KEY || null })
}))

// POST /dp/push-subscribe — save this device's push subscription (dedup by endpoint)
router.post('/dp/push-subscribe', requireDp, asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const { subscription } = req.body
  if (!subscription || !subscription.endpoint) return err('subscription with endpoint required')
  // Drop any stale entry for this endpoint, then store the fresh one (keys can rotate)
  await db.collection('delivery_persons').updateOne(
    { id: req.dpId },
    { $pull: { push_subscriptions: { endpoint: subscription.endpoint } } },
  )
  await db.collection('delivery_persons').updateOne(
    { id: req.dpId },
    { $push: { push_subscriptions: { ...subscription, subscribed_at: new Date() } } },
  )
  return ok({ success: true })
}))

// POST /dp/push-unsubscribe — remove this device's subscription (on logout)
router.post('/dp/push-unsubscribe', requireDp, asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const { endpoint } = req.body
  if (!endpoint) return err('endpoint required')
  await db.collection('delivery_persons').updateOne(
    { id: req.dpId },
    { $pull: { push_subscriptions: { endpoint } } },
  )
  return ok({ success: true })
}))

// POST /dp/decline-order
router.post('/dp/decline-order', requireDp, asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const dpId = req.dpId
  const { order_id } = req.body
  if (!order_id) return err('order_id required')
  const order = await db.collection('orders').findOne({ id: order_id })
  if (!order) return err('Order not found', 404)
  await db.collection('orders').updateOne(
    { id: order_id },
    { $pull: { assigned_decorators: dpId, accepted_decorators: dpId } }
  )
  return ok({ success: true, message: 'Order declined' })
}))

export default router
