import crypto from 'crypto'
import { TWO_FACTOR_API_KEY, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_ACCESS_TOKEN } from './config.js'

// ── Passwords & OTPs ─────────────────────────────────────────
export function hashPwd(pwd) {
  return crypto.createHash('sha256').update(pwd).digest('hex')
}
export function hashOtp(otp) {
  return crypto.createHash('sha256').update(`signup:${otp}`).digest('hex')
}

// ── SMS OTP via 2Factor.in ───────────────────────────────────
export async function sendOtpSms(phone, otp) {
  if (!TWO_FACTOR_API_KEY) return false
  try {
    const clean = String(phone).replace(/\D/g, '').replace(/^91/, '').slice(-10)
    if (clean.length !== 10) return false
    const res  = await fetch(`https://2factor.in/API/V1/${TWO_FACTOR_API_KEY}/SMS/${clean}/${otp}/OTP1`)
    const data = await res.json()
    return data.Status === 'Success'
  } catch (e) {
    console.error('[2Factor]', e.message)
    return false
  }
}

// ── WhatsApp Cloud API ───────────────────────────────────────
export async function sendWhatsApp(phone, message) {
  if (!WHATSAPP_PHONE_NUMBER_ID || !WHATSAPP_ACCESS_TOKEN) {
    console.log('[WhatsApp] env vars not set — skipping')
    return
  }
  try {
    const clean = String(phone).replace(/\D/g, '').replace(/^91/, '').slice(-10)
    if (clean.length !== 10) return
    await fetch(`https://graph.facebook.com/v19.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to:   '91' + clean,
        type: 'text',
        text: { body: message },
      }),
    })
  } catch (e) {
    console.error('[WhatsApp]', e.message)
  }
}

// ── City helpers ─────────────────────────────────────────────
const CITY_ALIASES = {
  'पुणे':'Pune','पुना':'Pune','रांची':'Ranchi','राँची':'Ranchi',
  'मुंबई':'Mumbai','बॉम्बे':'Mumbai','दिल्ली':'Delhi','नई दिल्ली':'Delhi',
  'नयी दिल्ली':'Delhi','बेंगलुरु':'Bangalore','बेंगलूरु':'Bangalore',
  'बैंगलोर':'Bangalore','हैदराबाद':'Hyderabad','चेन्नई':'Chennai',
  'कोलकाता':'Kolkata','जयपुर':'Jaipur','अहमदाबाद':'Ahmedabad',
  'सूरत':'Surat','नागपुर':'Nagpur','इंदौर':'Indore','भोपाल':'Bhopal',
  'लखनऊ':'Lucknow','पटना':'Patna','गुरुग्राम':'Gurugram',
  'गुड़गांव':'Gurugram','नोएडा':'Noida','कानपुर':'Kanpur',
  'नाशिक':'Nashik','औरंगाबाद':'Aurangabad','कोल्हापूर':'Kolhapur',
  'Pune':'Pune','pune':'Pune',
}
export function normalizeCityName(city) {
  if (!city) return city
  const t = city.trim()
  return CITY_ALIASES[t] || t
}
export function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
export async function isCityAllowed(db, city) {
  if (!city) return false
  const normalized = normalizeCityName(city)
  const doc = await db.collection('allowed_cities').findOne({
    name:   { $regex: new RegExp('^' + escapeRegex(normalized) + '$', 'i') },
    active: true,
  })
  return !!doc
}

// ── Route wrapper — provides ok/err + global error handler ───
export function asyncRoute(fn) {
  return async (req, res) => {
    const ok = (data, cache = 0) => {
      if (cache > 0) res.set('Cache-Control', `public, s-maxage=${cache}, stale-while-revalidate=${cache * 2}`)
      return res.json(data)
    }
    const err = (msg, status = 400) => res.status(status).json({ error: msg })
    try {
      await fn(req, res, ok, err)
    } catch (e) {
      console.error('[API Error]', e)
      res.status(500).json({ error: 'Internal server error: ' + e.message })
    }
  }
}
