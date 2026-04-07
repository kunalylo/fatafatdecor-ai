import { Router } from 'express'
import { connectToMongo } from '../db.js'
import { sendWhatsApp, asyncRoute } from '../helpers.js'

const router = Router()

// GET /delivery/slots
router.get('/delivery/slots', asyncRoute(async (req, res, ok, err) => {
  const db   = await connectToMongo()
  const date = req.query.date
  if (!date) return err('date required (YYYY-MM-DD)')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(new Date(date).getTime())) return err('Invalid date format. Use YYYY-MM-DD', 400)
  const deliveryPersons = await db.collection('delivery_persons').find({ is_active: true }).toArray()
  const blockedDocs     = await db.collection('blocked_slots').find({ date }).toArray()
  const blockedHours    = blockedDocs.map(b => b.hour)
  const slots = []
  for (let hour = 9; hour <= 20; hour++) {
    const isAdminBlocked = blockedHours.includes(hour)
    const bookedCount    = deliveryPersons.filter(dp => (dp.schedule?.[date] || []).includes(hour)).length
    const available      = deliveryPersons.length - bookedCount
    slots.push({ hour, time_label: `${hour}:00 - ${hour + 1}:00`, available: !isAdminBlocked && available > 0, available_count: isAdminBlocked ? 0 : available, admin_blocked: isAdminBlocked })
  }
  return ok({ date, slots }, 60)
}))

// POST /delivery/book
router.post('/delivery/book', asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const { order_id, date, hour } = req.body
  if (!order_id || !date || hour === undefined) return err('order_id, date, hour required')
  if (typeof hour !== 'number' || hour < 8 || hour > 21) return err('Invalid delivery hour. Must be between 8 and 21.', 400)
  const order = await db.collection('orders').findOne({ id: order_id })
  if (!order) return err('Order not found', 404)
  const deliveryPersons = await db.collection('delivery_persons').find({ is_active: true }).toArray()
  const assignedPerson  = deliveryPersons.find(dp => !(dp.schedule?.[date] || []).includes(hour))
  if (!assignedPerson) return err('No delivery person available for this slot.', 409)
  await db.collection('delivery_persons').updateOne({ id: assignedPerson.id }, { $push: { [`schedule.${date}`]: hour } })
  await db.collection('orders').updateOne({ id: order_id }, { $set: { delivery_person_id: assignedPerson.id, delivery_slot: { date, hour }, delivery_status: 'assigned' } })
  const slotUser = await db.collection('users').findOne({ id: order.user_id })
  if (slotUser?.phone) await sendWhatsApp(slotUser.phone, `FatafatDecor: Slot confirmed! Your decorator ${assignedPerson.name} will arrive on ${date} between ${hour}:00 - ${hour + 1}:00. Contact: ${assignedPerson.phone} -FatafatDecor`)
  return ok({ success: true, delivery_person: { id: assignedPerson.id, name: assignedPerson.name, phone: assignedPerson.phone }, slot: { date, hour, time_label: `${hour}:00 - ${hour + 1}:00` } })
}))

// POST /delivery/update-location
router.post('/delivery/update-location', asyncRoute(async (req, res, ok) => {
  const db = await connectToMongo()
  const { delivery_person_id, lat, lng } = req.body
  await db.collection('delivery_persons').updateOne({ id: delivery_person_id }, { $set: { current_location: { lat, lng, updated_at: new Date() } } })
  return ok({ success: true })
}))

// GET /delivery/track/:id
router.get('/delivery/track/:id', asyncRoute(async (req, res, ok, err) => {
  const db    = await connectToMongo()
  const order = await db.collection('orders').findOne({ id: req.params.id })
  if (!order) return err('Order not found', 404)
  const assignedInfo = order.assigned_decorators_info || []
  if (!order.delivery_person_id && assignedInfo.length === 0)
    return ok({ order_id: order.id, delivery_status: order.delivery_status || 'pending', delivery_slot: order.delivery_slot || null, delivery_person: null, assigned_decorators: [], delivery_location: null, user_location: order.delivery_location || null, message: 'Decorators not yet assigned' })
  const dp = order.delivery_person_id ? await db.collection('delivery_persons').findOne({ id: order.delivery_person_id }) : null
  return ok({ order_id: order.id, delivery_status: order.delivery_status, delivery_slot: order.delivery_slot, delivery_person: dp ? { name: dp.name, phone: dp.phone } : null, assigned_decorators: assignedInfo, delivery_location: dp?.current_location || null, user_location: order.delivery_location || null, verification_otp: order.verification_otp || null, otp_verified: order.otp_verified || false })
}))

// POST /delivery/status
router.post('/delivery/status', asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const { order_id, status, dp_id } = req.body
  if (!order_id || !status || !dp_id) return err('order_id, status, dp_id required')
  const VALID = ['pending','assigned','en_route','arrived','decorating','delivered','cancelled']
  if (!VALID.includes(status)) return err('Invalid status', 400)
  const order = await db.collection('orders').findOne({ id: order_id })
  if (!order) return err('Order not found', 404)
  const isAssigned = (order.accepted_decorators || []).includes(dp_id) || order.delivery_person_id === dp_id
  if (!isAssigned) return err('Not authorized to update this order', 403)
  await db.collection('orders').updateOne({ id: order_id }, { $set: { delivery_status: status } })
  return ok({ success: true })
}))

export default router
