import crypto from 'crypto'
import { Resend } from 'resend'
import { TWO_FACTOR_API_KEY, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_ACCESS_TOKEN, RESEND_API_KEY } from './config.js'

const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null

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

// ── Welcome Email via Resend ────────────────────────────────
export async function sendWelcomeEmail(name, email) {
  if (!resend || !email) return
  try {
    await resend.emails.send({
      from: 'FatafatDecor <welcome@mail.fatafatdecor.com>',
      to: email,
      subject: 'Welcome to FatafatDecor! 🎉',
      html: `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;padding:40px 20px">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1)">
  <tr><td style="background:linear-gradient(135deg,#7c3aed,#a855f7);padding:40px 30px;text-align:center">
    <h1 style="margin:0;color:#ffffff;font-size:28px">Welcome to FatafatDecor!</h1>
    <p style="margin:8px 0 0;color:#e9d5ff;font-size:16px">Your space, beautifully transformed</p>
  </td></tr>
  <tr><td style="padding:40px 30px">
    <p style="margin:0 0 20px;font-size:18px;color:#1f2937">Hi ${name},</p>
    <p style="margin:0 0 16px;font-size:15px;color:#4b5563;line-height:1.6">
      Thank you for joining FatafatDecor! We're excited to help you transform your spaces with AI-powered decoration.
    </p>
    <p style="margin:0 0 24px;font-size:15px;color:#4b5563;line-height:1.6">Here's what you can do:</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px">
      <tr><td style="padding:12px 16px;background:#f3f4f6;border-radius:8px;margin-bottom:8px">
        <strong style="color:#7c3aed">📸 Upload a photo</strong>
        <span style="color:#6b7280;font-size:14px"> — snap a pic of any room</span>
      </td></tr>
      <tr><td style="height:8px"></td></tr>
      <tr><td style="padding:12px 16px;background:#f3f4f6;border-radius:8px">
        <strong style="color:#7c3aed">✨ AI decorates it</strong>
        <span style="color:#6b7280;font-size:14px"> — see stunning decoration ideas instantly</span>
      </td></tr>
      <tr><td style="height:8px"></td></tr>
      <tr><td style="padding:12px 16px;background:#f3f4f6;border-radius:8px">
        <strong style="color:#7c3aed">🛒 Order & get it delivered</strong>
        <span style="color:#6b7280;font-size:14px"> — our decorators bring it to life</span>
      </td></tr>
    </table>
    <p style="margin:0 0 24px;font-size:15px;color:#4b5563;line-height:1.6">
      You've received <strong style="color:#7c3aed">3 free credits</strong> to try our AI decoration feature. Start exploring now!
    </p>
    <table cellpadding="0" cellspacing="0" style="margin:0 auto"><tr><td style="background:#7c3aed;border-radius:8px;padding:14px 32px">
      <a href="https://fatafatdecor.com" style="color:#ffffff;text-decoration:none;font-size:16px;font-weight:600">Start Decorating</a>
    </td></tr></table>
  </td></tr>
  <tr><td style="padding:24px 30px;background:#f9fafb;text-align:center;border-top:1px solid #e5e7eb">
    <p style="margin:0;font-size:13px;color:#9ca3af">
      FatafatDecor — AI-Powered Decoration, Delivered to Your Door
    </p>
  </td></tr>
</table>
</td></tr></table>
</body>
</html>`,
    })
  } catch (e) {
    console.error('[Resend] Welcome email failed:', e.message)
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
