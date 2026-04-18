import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import crypto from 'crypto'
import Razorpay from 'razorpay'
import { connectToMongo } from '../db.js'
import { requireUser } from '../jwt.js'
import { sendWhatsApp, asyncRoute } from '../helpers.js'
import { RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET } from '../config.js'

const router = Router()

// POST /payments/create-order — requires JWT
router.post('/payments/create-order', requireUser, asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const user_id = req.userId
  const { type, amount, order_id, credits_count } = req.body
  if (!type || !amount) return err('type and amount required')
  const amt = Number(amount)
  if (!Number.isFinite(amt) || amt <= 0) return err('Invalid payment amount', 400)
  if (amt > 100000) return err('Payment amount exceeds limit', 400)

  // Validate credits_count for credit purchases
  if (type === 'credits') {
    const cc = Number(credits_count)
    if (!Number.isInteger(cc) || cc <= 0 || cc > 50) return err('Invalid credits count', 400)
  }

  // If paying for a specific order, verify it belongs to this user
  if (order_id) {
    const coll = type === 'gift_delivery' ? 'gift_orders' : 'orders'
    const order = await db.collection(coll).findOne({ id: order_id })
    if (!order) return err('Order not found', 404)
    if (order.user_id !== user_id) return err('Not authorized', 403)
  }

  const rzp      = new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET })
  const rzpOrder = await rzp.orders.create({ amount: Math.round(amt * 100), currency: 'INR', receipt: `${type}_${uuidv4().slice(0, 8)}` })
  const payment  = { id: uuidv4(), type, user_id, order_id: order_id || null, credits_count: credits_count || 0, amount: amt, razorpay_order_id: rzpOrder.id, status: 'created', created_at: new Date() }
  await db.collection('payments').insertOne(payment)
  return ok({ razorpay_order_id: rzpOrder.id, amount: rzpOrder.amount, currency: 'INR', payment_id: payment.id, razorpay_key_id: RAZORPAY_KEY_ID })
}))

// POST /payments/verify — requires JWT + validates payment belongs to user
router.post('/payments/verify', requireUser, asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) return err('Missing payment fields', 400)

  // Verify Razorpay signature
  const generatedSig = crypto.createHmac('sha256', RAZORPAY_KEY_SECRET).update(razorpay_order_id + '|' + razorpay_payment_id).digest('hex')
  if (generatedSig !== razorpay_signature) return err('Payment verification failed', 400)

  const payment = await db.collection('payments').findOne({ razorpay_order_id })
  if (!payment) return err('Payment not found', 404)
  if (payment.user_id !== req.userId) return err('Not authorized', 403)
  if (payment.status === 'verified') return ok({ success: true, type: payment.type, message: 'Already verified' })

  await db.collection('payments').updateOne(
    { razorpay_order_id },
    { $set: { status: 'verified', razorpay_payment_id, razorpay_signature, verified_at: new Date() } }
  )

  if (payment.type === 'credits') {
    await db.collection('users').updateOne(
      { id: payment.user_id },
      { $inc: { credits: payment.credits_count }, $set: { has_purchased_credits: true } }
    )
  }
  if (payment.type === 'delivery' && payment.order_id) {
    await db.collection('orders').updateOne(
      { id: payment.order_id },
      { $set: { payment_status: 'partial', payment_amount: payment.amount } }
    )
    // Mark design as 'ordered' NOW that payment succeeded (not at order creation)
    const paidOrder = await db.collection('orders').findOne({ id: payment.order_id })
    if (paidOrder?.design_id) {
      await db.collection('designs').updateOne({ id: paidOrder.design_id }, { $set: { status: 'ordered' } })
    }
    // Reward: +1 credit for booking a design
    await db.collection('users').updateOne({ id: payment.user_id }, { $inc: { credits: 1 } })
    const payUser = await db.collection('users').findOne({ id: payment.user_id })
    if (payUser?.phone) await sendWhatsApp(payUser.phone, `FatafatDecor: Payment of Rs.${payment.amount} received! Your booking is confirmed. You earned +1 free credit! Decorator will arrive at the selected time. -FatafatDecor`)

    // NOW assign decorators and notify them — only after confirmed payment
    if (paidOrder && (!paidOrder.assigned_decorators || paidOrder.assigned_decorators.length === 0)) {
      const availablePersons = await db.collection('delivery_persons').find({ is_active: true }).toArray()
      if (availablePersons.length > 0) {
        const assignedIds  = availablePersons.map(p => p.id)
        const assignedInfo = availablePersons.map(p => ({ id: p.id, name: p.name, phone: p.phone }))
        await db.collection('orders').updateOne(
          { id: payment.order_id },
          { $set: { assigned_decorators: assignedIds, assigned_decorators_info: assignedInfo, delivery_status: 'pending' } }
        )
        for (const dp of availablePersons) {
          if (dp.phone) await sendWhatsApp(dp.phone, `FatafatDecor NEW ORDER #${payment.order_id.slice(0, 8)}: ${paidOrder.delivery_address || 'Address not set'}. Amount: Rs.${paidOrder.total_cost}. Open your decorator app now to accept! -FatafatDecor`)
        }
      }
    }
  }
  if (payment.type === 'gift_delivery' && payment.order_id) {
    // Validate payment amount covers the gift order total
    const giftOrder = await db.collection('gift_orders').findOne({ id: payment.order_id })
    if (giftOrder && payment.amount < giftOrder.gift_total) return err('Payment amount less than gift order total', 400)
    await db.collection('gift_orders').updateOne(
      { id: payment.order_id },
      { $set: { payment_status: 'full', payment_amount: payment.amount } }
    )
    const giftPayUser = await db.collection('users').findOne({ id: payment.user_id })
    if (giftPayUser?.phone) await sendWhatsApp(giftPayUser.phone, `FatafatDecor: Gift order payment of Rs.${payment.amount} received! Your gift delivery is confirmed. -FatafatDecor`)

    // Assign decorators to gift order now that payment is confirmed
    if (giftOrder && (!giftOrder.assigned_decorators || giftOrder.assigned_decorators.length === 0)) {
      const activePersons = await db.collection('delivery_persons').find({ is_active: true }).toArray()
      if (activePersons.length > 0) {
        const assignedIds  = activePersons.map(p => p.id)
        const assignedInfo = activePersons.map(p => ({ id: p.id, name: p.name, phone: p.phone }))
        await db.collection('gift_orders').updateOne(
          { id: payment.order_id },
          { $set: { assigned_decorators: assignedIds, assigned_decorators_info: assignedInfo, delivery_status: 'pending' } }
        )
        for (const dp of activePersons) {
          if (dp.phone) await sendWhatsApp(dp.phone, `FatafatDecor GIFT ORDER #${payment.order_id.slice(0, 8)}: ${giftOrder.delivery_address || 'Address not set'}. Amount: Rs.${giftOrder.gift_total}. Open your decorator app now to accept! -FatafatDecor`)
        }
      }
    }
  }
  return ok({ success: true, type: payment.type })
}))

// POST /payments/handle-failure — requires JWT
router.post('/payments/handle-failure', requireUser, asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const { payment_id, reason } = req.body
  if (!payment_id) return ok({ success: true })
  const payment = await db.collection('payments').findOne({ id: payment_id })
  if (payment && payment.user_id !== req.userId) return err('Not authorized', 403)
  await db.collection('payments').updateOne(
    { id: payment_id, user_id: req.userId },
    { $set: { status: 'failed', failed_at: new Date(), failure_reason: reason || 'user_cancelled' } }
  )
  return ok({ success: true })
}))

export default router
