import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import crypto from 'crypto'
import Razorpay from 'razorpay'
import { connectToMongo } from '../db.js'
import { getUserIdFromRequest } from '../jwt.js'
import { sendWhatsApp, asyncRoute } from '../helpers.js'
import { RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET } from '../config.js'

const router = Router()

// POST /payments/create-order
router.post('/payments/create-order', asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const body = req.body
  const { type, amount, order_id, credits_count } = body
  const user_id = await getUserIdFromRequest(req, body.user_id)
  if (!type || !amount || !user_id) return err('type, amount, user_id required')
  if (Number(amount) <= 0) return err('Invalid payment amount', 400)
  const rzp      = new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET })
  const rzpOrder = await rzp.orders.create({ amount: Math.round(amount * 100), currency: 'INR', receipt: `${type}_${uuidv4().slice(0, 8)}` })
  const payment  = { id: uuidv4(), type, user_id, order_id: order_id || null, credits_count: credits_count || 0, amount, razorpay_order_id: rzpOrder.id, status: 'created', created_at: new Date() }
  await db.collection('payments').insertOne(payment)
  return ok({ razorpay_order_id: rzpOrder.id, amount: rzpOrder.amount, currency: 'INR', payment_id: payment.id, razorpay_key_id: RAZORPAY_KEY_ID })
}))

// POST /payments/verify
router.post('/payments/verify', asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) return err('Missing payment fields', 400)
  const generatedSig = crypto.createHmac('sha256', RAZORPAY_KEY_SECRET).update(razorpay_order_id + '|' + razorpay_payment_id).digest('hex')
  if (generatedSig !== razorpay_signature) return err('Payment verification failed', 400)
  const payment = await db.collection('payments').findOne({ razorpay_order_id })
  if (!payment) return err('Payment not found', 404)
  await db.collection('payments').updateOne({ razorpay_order_id }, { $set: { status: 'verified', razorpay_payment_id, razorpay_signature } })
  if (payment.type === 'credits') {
    await db.collection('users').updateOne({ id: payment.user_id }, { $inc: { credits: payment.credits_count }, $set: { has_purchased_credits: true } })
  }
  if (payment.type === 'delivery' && payment.order_id) {
    await db.collection('orders').updateOne({ id: payment.order_id }, { $set: { payment_status: 'partial', payment_amount: payment.amount } })
    const payUser = await db.collection('users').findOne({ id: payment.user_id })
    if (payUser?.phone) await sendWhatsApp(payUser.phone, `FatafatDecor: Payment of Rs.${payment.amount} received! Your booking is confirmed. Decorator will arrive at the selected time. -FatafatDecor`)
  }
  if (payment.type === 'gift_delivery' && payment.order_id) {
    await db.collection('gift_orders').updateOne({ id: payment.order_id }, { $set: { payment_status: 'full', payment_amount: payment.amount } })
    const giftPayUser = await db.collection('users').findOne({ id: payment.user_id })
    if (giftPayUser?.phone) await sendWhatsApp(giftPayUser.phone, `FatafatDecor: Gift order payment of Rs.${payment.amount} received! Your gift delivery is confirmed. -FatafatDecor`)
  }
  return ok({ success: true, type: payment.type })
}))

// POST /payments/handle-failure
router.post('/payments/handle-failure', asyncRoute(async (req, res, ok) => {
  const db = await connectToMongo()
  const { payment_id, reason } = req.body
  if (payment_id) await db.collection('payments').updateOne({ id: payment_id }, { $set: { status: 'failed', failed_at: new Date(), failure_reason: reason || 'user_cancelled' } })
  return ok({ success: true })
}))

export default router
