// Web Push (VAPID) — sends new-order notifications to decorators even when
// their app is closed. Subscriptions are stored on delivery_persons.push_subscriptions[].
import webpush from 'web-push'
import { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } from './config.js'

let configured = false
function ensureConfigured() {
  if (configured) return true
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return false
  try {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY)
    configured = true
  } catch (e) {
    console.warn('[push] VAPID config failed:', e.message)
    return false
  }
  return true
}

export function pushConfigured() {
  return !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY)
}

// Send a push to every device a decorator has subscribed. Never throws; prunes
// dead subscriptions (404/410). No-op until VAPID env vars are set.
export async function sendPushToDecorator(db, dpId, payload) {
  try {
    if (!ensureConfigured()) return
    const dp = await db.collection('delivery_persons').findOne({ id: dpId })
    const subs = (dp && dp.push_subscriptions) || []
    if (subs.length === 0) return
    const body = JSON.stringify(payload)
    const dead = []
    await Promise.all(subs.map(async (sub) => {
      try {
        await webpush.sendNotification(sub, body)
      } catch (e) {
        const code = e.statusCode
        if (code === 404 || code === 410) dead.push(sub.endpoint)
        else console.warn('[push] send failed:', code || e.message)
      }
    }))
    if (dead.length > 0) {
      await db.collection('delivery_persons').updateOne(
        { id: dpId },
        { $pull: { push_subscriptions: { endpoint: { $in: dead } } } },
      ).catch(() => {})
    }
  } catch (e) {
    console.warn('[push] sendPushToDecorator error:', e.message)
  }
}
