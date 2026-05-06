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
<body style="margin:0;padding:0;background:#fff5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#fff5f7;padding:40px 20px">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(236,72,153,0.12)">

  <!-- Logo + Header -->
  <tr><td style="background:linear-gradient(135deg,#ec4899,#f472b6,#f9a8d4);padding:36px 30px 28px;text-align:center">
    <img src="https://fatafatdecor.com/logo.png" alt="FatafatDecor" width="90" height="90" style="display:block;margin:0 auto 16px;border-radius:50%;border:3px solid rgba(255,255,255,0.4);background:#fff" />
    <h1 style="margin:0;color:#ffffff;font-size:26px;font-weight:700;letter-spacing:-0.5px">Welcome to FatafatDecor!</h1>
    <p style="margin:6px 0 0;color:rgba(255,255,255,0.85);font-size:15px">Your space, beautifully transformed</p>
  </td></tr>

  <!-- Body -->
  <tr><td style="padding:36px 32px 28px">
    <p style="margin:0 0 18px;font-size:18px;color:#1f2937;font-weight:600">Hi ${name} 👋</p>
    <p style="margin:0 0 20px;font-size:15px;color:#4b5563;line-height:1.7">
      Thank you for joining <strong style="color:#ec4899">FatafatDecor</strong>! We're thrilled to help you transform any space with AI-powered decoration.
    </p>

    <!-- Steps -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px">
      <tr><td style="padding:14px 18px;background:linear-gradient(135deg,#fdf2f8,#fce7f3);border-radius:10px;border-left:4px solid #ec4899">
        <strong style="color:#be185d;font-size:15px">📸 Upload a Photo</strong><br/>
        <span style="color:#6b7280;font-size:13px;line-height:1.5">Snap a pic of any room you want to decorate</span>
      </td></tr>
      <tr><td style="height:10px"></td></tr>
      <tr><td style="padding:14px 18px;background:linear-gradient(135deg,#fdf2f8,#fce7f3);border-radius:10px;border-left:4px solid #f472b6">
        <strong style="color:#be185d;font-size:15px">✨ AI Decorates It</strong><br/>
        <span style="color:#6b7280;font-size:13px;line-height:1.5">See stunning decoration ideas generated instantly</span>
      </td></tr>
      <tr><td style="height:10px"></td></tr>
      <tr><td style="padding:14px 18px;background:linear-gradient(135deg,#fdf2f8,#fce7f3);border-radius:10px;border-left:4px solid #f9a8d4">
        <strong style="color:#be185d;font-size:15px">🎉 Order & Get It Delivered</strong><br/>
        <span style="color:#6b7280;font-size:13px;line-height:1.5">Our decorators bring the design to life at your doorstep</span>
      </td></tr>
    </table>

    <!-- Free credits -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px">
      <tr><td style="background:#fdf2f8;border:2px dashed #f9a8d4;border-radius:12px;padding:18px 20px;text-align:center">
        <p style="margin:0 0 4px;font-size:14px;color:#9ca3af">YOUR FREE GIFT</p>
        <p style="margin:0;font-size:22px;font-weight:700;color:#ec4899">🎁 3 Free AI Credits</p>
        <p style="margin:6px 0 0;font-size:13px;color:#6b7280">Start designing your dream space right away!</p>
      </td></tr>
    </table>

    <!-- CTA Button -->
    <table cellpadding="0" cellspacing="0" style="margin:0 auto"><tr><td style="background:linear-gradient(135deg,#ec4899,#f472b6);border-radius:10px;padding:15px 40px;box-shadow:0 4px 14px rgba(236,72,153,0.3)">
      <a href="https://fatafatdecor.com" style="color:#ffffff;text-decoration:none;font-size:16px;font-weight:700;letter-spacing:0.3px">Start Decorating →</a>
    </td></tr></table>
  </td></tr>

  <!-- Footer -->
  <tr><td style="padding:22px 30px;background:#fdf2f8;text-align:center;border-top:1px solid #fce7f3">
    <p style="margin:0 0 6px;font-size:13px;color:#ec4899;font-weight:600">FatafatDecor</p>
    <p style="margin:0;font-size:12px;color:#9ca3af">AI-Powered Decoration, Delivered to Your Door</p>
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
