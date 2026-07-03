import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import crypto from 'crypto'
import Razorpay from 'razorpay'
import { connectToMongo } from '../db.js'
import { requireUser } from '../jwt.js'
import { sendWhatsApp, sendOrderBookedEmail, sendPaymentReceiptEmail, asyncRoute, sameCity, resolveOrderCity } from '../helpers.js'
import { sendPushToDecorator } from '../push.js'
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

  // If paying for a specific order, verify it belongs to this user.
  // Delivery orders live in `draft_orders` until paid (fall back to `orders` for legacy rows).
  if (order_id) {
    let order
    if (type === 'gift_delivery') {
      order = await db.collection('gift_orders').findOne({ id: order_id })
    } else {
      order = await db.collection('draft_orders').findOne({ id: order_id })
        || await db.collection('orders').findOne({ id: order_id })
    }
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

  // ── Promote the draft order → real `orders` collection (idempotent, final paid state) ──
  // Runs on EVERY verify call (even retries) BEFORE the payment is claimed, so a crashed or
  // retried verify can never leave the customer paid with no order. Only paid orders ever
  // reach `orders`; unpaid/abandoned drafts stay in `draft_orders`.
  if (payment.type === 'delivery' && payment.order_id) {
    const existing = await db.collection('orders').findOne({ id: payment.order_id })
    if (existing) {
      await db.collection('orders').updateOne(
        { id: payment.order_id },
        { $set: { payment_status: 'partial', payment_amount: payment.amount, delivery_status: 'pending' } }
      )
    } else {
      const draft = await db.collection('draft_orders').findOne({ id: payment.order_id })
      if (!draft) return err('Order not found', 404)
      const { _id, ...draftOrder } = draft
      try {
        // Upsert the final paid state in one write — no transient "pending" window.
        await db.collection('orders').updateOne(
          { id: payment.order_id },
          { $setOnInsert: { ...draftOrder, payment_status: 'partial', payment_amount: payment.amount, delivery_status: 'pending' } },
          { upsert: true }
        )
      } catch (e) {
        if (e.code !== 11000) throw e   // lost the insert race to a concurrent verify — order already exists
        await db.collection('orders').updateOne(
          { id: payment.order_id },
          { $set: { payment_status: 'partial', payment_amount: payment.amount, delivery_status: 'pending' } }
        )
      }
    }
    await db.collection('draft_orders').deleteOne({ id: payment.order_id })
  }

  // ── Mark the gift order paid BEFORE the claim (idempotent), mirroring the delivery promote ──
  // A crash/retry can then never leave a paid gift order stuck as unpaid (which would block
  // slot booking). Amount validation happens here, before the payment is ever marked verified.
  if (payment.type === 'gift_delivery' && payment.order_id) {
    const giftOrder = await db.collection('gift_orders').findOne({ id: payment.order_id })
    if (!giftOrder) return err('Gift order not found', 404)
    if (payment.amount < giftOrder.gift_total) return err('Payment amount less than gift order total', 400)
    await db.collection('gift_orders').updateOne(
      { id: payment.order_id },
      { $set: { payment_status: 'full', payment_amount: payment.amount } }
    )
  }

  // ── Atomically claim the payment so the side-effects below run EXACTLY once ──
  // Only a freshly-created payment may transition to verified — a 'failed' (user-cancelled) or
  // already-'verified' record won't re-trigger side-effects. The first caller wins; concurrent/
  // retried calls return here. Prevents double credit award / stock decrement / decorator assignment.
  const claim = await db.collection('payments').updateOne(
    { razorpay_order_id, status: 'created' },
    { $set: { status: 'verified', razorpay_payment_id, razorpay_signature, verified_at: new Date() } }
  )
  if (claim.modifiedCount === 0) return ok({ success: true, type: payment.type, message: 'Already verified' })

  if (payment.type === 'credits') {
    await db.collection('users').updateOne(
      { id: payment.user_id },
      { $inc: { credits: payment.credits_count }, $set: { has_purchased_credits: true } }
    )
  }
  if (payment.type === 'delivery' && payment.order_id) {
    // Order is already promoted to its final paid state above — just run one-time side-effects.
    const paidOrder = await db.collection('orders').findOne({ id: payment.order_id })
    if (paidOrder?.design_id) {
      await db.collection('designs').updateOne({ id: paidOrder.design_id }, { $set: { status: 'ordered' } })
    }

    // ── Reserve SKU stock for reference-flow orders ──
    // Decrement master_inventory.stock_count by the quantity used. Negative stock
    // is allowed (admin notices and restocks); we never block an order over stock.
    if (paidOrder?.flow === 'reference' && Array.isArray(paidOrder.items)) {
      for (const it of paidOrder.items) {
        const skuCode = it.matched_sku_code || it.sku_code
        const qty     = Number(it.quantity) || 0
        if (skuCode && qty > 0) {
          await db.collection('master_inventory').updateOne(
            { sku_code: skuCode },
            { $inc: { stock_count: -qty }, $set: { last_used_at: new Date() } },
          ).catch(e => console.warn('[stock-decrement]', skuCode, e.message))
        }
      }
    }

    // ── Bump reference use_count when an order is confirmed (conversion analytics) ──
    if (paidOrder?.flow === 'reference' && paidOrder.reference_design_id) {
      await db.collection('reference_designs').updateOne(
        { id: paidOrder.reference_design_id },
        { $inc: { use_count: 1 }, $set: { last_used_at: new Date() } },
      ).catch(e => console.warn('[reference-use-count]', e.message))
    }
    // Reward: +1 credit for booking a design
    await db.collection('users').updateOne({ id: payment.user_id }, { $inc: { credits: 1 } })
    const payUser = await db.collection('users').findOne({ id: payment.user_id })
    if (payUser?.phone) await sendWhatsApp(payUser.phone, `FatafatDecor: Payment of Rs.${payment.amount} received! Your booking is confirmed. You earned +1 free credit! Decorator will arrive at the selected time. -FatafatDecor`)
    if (payUser?.email) {
      sendOrderBookedEmail(payUser.name, payUser.email, paidOrder, 'decoration')
      sendPaymentReceiptEmail(payUser.name, payUser.email, payment, paidOrder, 'decoration')
    }

    // NOW assign decorators and notify them — only after confirmed payment.
    // City scoping: a decorator only gets orders from their own city. A decorator who has set their
    // city receives only that city's orders; decorators with no city set still receive everything
    // (so onboarding isn't blocked). If we can't resolve the order's city, fall back to all active.
    if (paidOrder && (!paidOrder.assigned_decorators || paidOrder.assigned_decorators.length === 0)) {
      const orderCity = await resolveOrderCity(db, paidOrder)
      const allActive = await db.collection('delivery_persons').find({ is_active: true }).toArray()
      const availablePersons = allActive.filter(p => !p.city || !orderCity || sameCity(p.city, orderCity))
      if (availablePersons.length > 0) {
        const assignedIds  = availablePersons.map(p => p.id)
        const assignedInfo = availablePersons.map(p => ({ id: p.id, name: p.name, phone: p.phone }))
        await db.collection('orders').updateOne(
          { id: payment.order_id },
          { $set: { assigned_decorators: assignedIds, assigned_decorators_info: assignedInfo, delivery_status: 'pending', city: orderCity || paidOrder.city || null } }
        )
        // Decorators only see what they must collect, never the order total.
        const dpCollect = Math.max(0, Math.round((paidOrder.total_cost || 0) - (paidOrder.payment_amount || 0)))
        for (const dp of availablePersons) {
          if (dp.phone) await sendWhatsApp(dp.phone, `FatafatDecor NEW ORDER #${payment.order_id.slice(0, 8)}: ${paidOrder.delivery_address || 'Address not set'}. Collect on delivery: Rs.${dpCollect}. Open your decorator app now to accept! -FatafatDecor`)
          sendPushToDecorator(db, dp.id, {
            title: '🎉 New order available!',
            body: `New booking · Collect Rs.${dpCollect} · ${(paidOrder.delivery_address || 'Tap to view').slice(0, 60)}. Accept before another decorator does.`,
            tag: `fd-order-${payment.order_id.slice(0, 8)}`,
            url: '/',
          }).catch(() => {})
        }
      }
    }
  }
  if (payment.type === 'gift_delivery' && payment.order_id) {
    // Gift order already marked paid above — run one-time side-effects (stock, notify, assign).
    const giftOrder = await db.collection('gift_orders').findOne({ id: payment.order_id })
    // Decrement stock now that payment is confirmed (gift orders reserve here, not at creation)
    if (giftOrder && !giftOrder.stock_reserved && Array.isArray(giftOrder.gift_items)) {
      for (const gi of giftOrder.gift_items) {
        if (gi.gift_id) await db.collection('gifts').updateOne({ id: gi.gift_id }, { $inc: { stock: -(Number(gi.quantity) || 1) } }).catch(() => {})
      }
      await db.collection('gift_orders').updateOne({ id: payment.order_id }, { $set: { stock_reserved: true } })
    }
    const giftPayUser = await db.collection('users').findOne({ id: payment.user_id })
    if (giftPayUser?.phone) await sendWhatsApp(giftPayUser.phone, `FatafatDecor: Gift order payment of Rs.${payment.amount} received! Your gift delivery is confirmed. -FatafatDecor`)
    if (giftPayUser?.email) {
      sendOrderBookedEmail(giftPayUser.name, giftPayUser.email, giftOrder, 'gift')
      sendPaymentReceiptEmail(giftPayUser.name, giftPayUser.email, payment, giftOrder, 'gift')
    }

    // Assign decorators to gift order now that payment is confirmed (city-scoped, same rule as above)
    if (giftOrder && (!giftOrder.assigned_decorators || giftOrder.assigned_decorators.length === 0)) {
      const giftCity = await resolveOrderCity(db, giftOrder)
      const allActiveGift = await db.collection('delivery_persons').find({ is_active: true }).toArray()
      const activePersons = allActiveGift.filter(p => !p.city || !giftCity || sameCity(p.city, giftCity))
      if (activePersons.length > 0) {
        const assignedIds  = activePersons.map(p => p.id)
        const assignedInfo = activePersons.map(p => ({ id: p.id, name: p.name, phone: p.phone }))
        await db.collection('gift_orders').updateOne(
          { id: payment.order_id },
          { $set: { assigned_decorators: assignedIds, assigned_decorators_info: assignedInfo, delivery_status: 'pending', city: giftCity || giftOrder.city || null } }
        )
        for (const dp of activePersons) {
          if (dp.phone) await sendWhatsApp(dp.phone, `FatafatDecor GIFT ORDER #${payment.order_id.slice(0, 8)}: ${giftOrder.delivery_address || 'Address not set'}. Prepaid — nothing to collect. Open your decorator app now to accept! -FatafatDecor`)
          sendPushToDecorator(db, dp.id, {
            title: '🎁 New gift order!',
            body: `Gift delivery · Prepaid · ${(giftOrder.delivery_address || 'Tap to view').slice(0, 60)}. Tap to accept.`,
            tag: `fd-gift-${payment.order_id.slice(0, 8)}`,
            url: '/',
          }).catch(() => {})
        }
      }
    }
  }
  return ok({ success: true, type: payment.type })
}))

// POST /payments/verify-apple-iap — requires JWT
// Trusts Apple-validated purchase; uses transaction_id uniqueness to prevent replays
router.post('/payments/verify-apple-iap', requireUser, asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const { product_id, transaction_id } = req.body
  if (!product_id || !transaction_id) return err('Missing fields', 400)

  const PRODUCT_CREDITS = {
    'in.co.ylo.fatafatdecor.credits.1': 1,
    'in.co.ylo.fatafatdecor.credits.5': 5,
    'in.co.ylo.fatafatdecor.credits.12': 12,
    'in.co.ylo.fatafatdecor.credits.25': 25,
  }
  const credits_count = PRODUCT_CREDITS[product_id]
  if (!credits_count) return err('Invalid product', 400)

  // Replay-attack prevention — each Apple transaction ID is globally unique
  const existing = await db.collection('payments').findOne({ apple_transaction_id: transaction_id })
  if (existing) {
    if (existing.user_id !== req.userId) return err('Transaction already used by another account', 403)
    if (existing.status === 'verified') {
      const u = await db.collection('users').findOne({ id: req.userId })
      return ok({ success: true, credits_added: 0, new_credits: u?.credits || 0, already_verified: true })
    }
  }

  const payment = {
    id: uuidv4(), type: 'credits', platform: 'apple_iap',
    user_id: req.userId, credits_count,
    apple_product_id: product_id, apple_transaction_id: transaction_id,
    status: 'verified', created_at: new Date(), verified_at: new Date(),
  }
  await db.collection('payments').insertOne(payment)

  const updatedUser = await db.collection('users').findOneAndUpdate(
    { id: req.userId },
    { $inc: { credits: credits_count }, $set: { has_purchased_credits: true } },
    { returnDocument: 'after' }
  )
  return ok({ success: true, credits_added: credits_count, new_credits: updatedUser?.credits || 0 })
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
