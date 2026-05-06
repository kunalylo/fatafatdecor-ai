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
    <img src="https://ik.imagekit.io/jcp2urr7b/branding/icon-512.png?updatedAt=1776066798777" alt="FatafatDecor" width="90" height="90" style="display:block;margin:0 auto 16px;border-radius:50%;border:3px solid rgba(255,255,255,0.4);background:#fff" />
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

  <!-- Download App -->
  <tr><td style="padding:24px 32px 28px;text-align:center;border-top:1px solid #fce7f3">
    <p style="margin:0 0 16px;font-size:15px;color:#1f2937;font-weight:600">📱 Get the App</p>
    <table cellpadding="0" cellspacing="0" style="margin:0 auto"><tr>
      <td style="padding-right:12px">
        <a href="https://play.google.com/store/apps/details?id=in.co.ylo.fatafatdecor.twa" style="text-decoration:none">
          <img src="https://play.google.com/intl/en_us/badges/static/images/badges/en_badge_web_generic.png" alt="Get it on Google Play" height="44" style="display:block" />
        </a>
      </td>
      <td>
        <a href="https://apps.apple.com/us/app/fatafatdecor/id6763261185" style="text-decoration:none">
          <img src="https://developer.apple.com/assets/elements/badges/download-on-the-app-store.svg" alt="Download on the App Store" height="44" style="display:block" />
        </a>
      </td>
    </tr></table>
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

const LOGO_URL = 'https://ik.imagekit.io/jcp2urr7b/branding/icon-512.png?updatedAt=1776066798777'
const EMAIL_HEADER = `
  <tr><td style="background:linear-gradient(135deg,#ec4899,#f472b6,#f9a8d4);padding:32px 30px 24px;text-align:center">
    <img src="${LOGO_URL}" alt="FatafatDecor" width="70" height="70" style="display:block;margin:0 auto 12px;border-radius:50%;border:3px solid rgba(255,255,255,0.4);background:#fff" />
  </td></tr>`
const EMAIL_FOOTER = `
  <tr><td style="padding:22px 30px;background:#fdf2f8;text-align:center;border-top:1px solid #fce7f3">
    <p style="margin:0 0 6px;font-size:13px;color:#ec4899;font-weight:600">FatafatDecor</p>
    <p style="margin:0;font-size:12px;color:#9ca3af">AI-Powered Decoration, Delivered to Your Door</p>
  </td></tr>`

function emailWrap(content) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#fff5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#fff5f7;padding:40px 20px">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(236,72,153,0.12)">
${EMAIL_HEADER}${content}${EMAIL_FOOTER}
</table></td></tr></table></body></html>`
}

// ── Order Booked Email ──────────────────────────────────────
export async function sendOrderBookedEmail(name, email, order, orderType) {
  if (!resend || !email) return
  const isGift = orderType === 'gift'
  const orderId = order.id.slice(0, 8).toUpperCase()
  const total = order.total_cost || order.gift_total || 0
  const paidNow = order.payment_amount || 0
  const remaining = isGift ? 0 : total - paidNow
  const itemsHtml = isGift
    ? (order.gift_items || []).map(g => `
      <tr><td style="padding:10px 14px;border-bottom:1px solid #fce7f3;font-size:14px;color:#1f2937">${g.name || 'Gift Item'}</td>
      <td style="padding:10px 14px;border-bottom:1px solid #fce7f3;font-size:14px;color:#1f2937;text-align:center">${g.quantity || 1}</td>
      <td style="padding:10px 14px;border-bottom:1px solid #fce7f3;font-size:14px;color:#1f2937;text-align:right">Rs.${(Number(g.price) || 0) * (g.quantity || 1)}</td></tr>`).join('')
    : (order.items || []).map(item => `
      <tr><td style="padding:10px 14px;border-bottom:1px solid #fce7f3;font-size:14px;color:#1f2937" colspan="2">${item.name || item.title || 'Decoration Item'}</td>
      <td style="padding:10px 14px;border-bottom:1px solid #fce7f3;font-size:14px;color:#1f2937;text-align:right">Rs.${item.price || item.cost || 0}</td></tr>`).join('')

  try {
    await resend.emails.send({
      from: 'FatafatDecor <orders@mail.fatafatdecor.com>',
      to: email,
      subject: `Order Confirmed! #${orderId} 🎉`,
      html: emailWrap(`
  <tr><td style="padding:32px 32px 28px">
    <h2 style="margin:0 0 6px;font-size:22px;color:#1f2937">Order Confirmed!</h2>
    <p style="margin:0 0 24px;font-size:14px;color:#9ca3af">Order #${orderId}</p>

    <p style="margin:0 0 20px;font-size:15px;color:#4b5563;line-height:1.7">
      Hi <strong>${name}</strong>, your ${isGift ? 'gift' : 'decoration'} order has been booked successfully!
    </p>

    <!-- Order Items -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;border:1px solid #fce7f3;border-radius:10px;overflow:hidden">
      <tr style="background:#fdf2f8">
        <td style="padding:10px 14px;font-size:13px;color:#be185d;font-weight:600">${isGift ? 'Gift' : 'Item'}</td>
        ${isGift ? '<td style="padding:10px 14px;font-size:13px;color:#be185d;font-weight:600;text-align:center">Qty</td>' : '<td></td>'}
        <td style="padding:10px 14px;font-size:13px;color:#be185d;font-weight:600;text-align:right">Price</td>
      </tr>
      ${itemsHtml}
    </table>

    <!-- Payment Summary -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;background:#fdf2f8;border-radius:10px;overflow:hidden">
      <tr><td style="padding:12px 16px;font-size:14px;color:#4b5563">Order Total</td>
      <td style="padding:12px 16px;font-size:14px;color:#1f2937;text-align:right;font-weight:600">Rs.${total}</td></tr>
      <tr><td style="padding:12px 16px;font-size:14px;color:#4b5563">Paid Now ${isGift ? '(100%)' : '(50%)'}</td>
      <td style="padding:12px 16px;font-size:14px;color:#16a34a;text-align:right;font-weight:600">Rs.${paidNow}</td></tr>
      ${remaining > 0 ? `<tr><td style="padding:12px 16px;font-size:14px;color:#4b5563">Due After Decoration (50%)</td>
      <td style="padding:12px 16px;font-size:14px;color:#ea580c;text-align:right;font-weight:600">Rs.${remaining}</td></tr>` : ''}
    </table>

    ${order.delivery_address ? `
    <!-- Delivery Address -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px">
      <tr><td style="padding:14px 18px;background:#f0fdf4;border-radius:10px;border-left:4px solid #22c55e">
        <strong style="color:#15803d;font-size:13px">📍 DELIVERY ADDRESS</strong><br/>
        <span style="color:#4b5563;font-size:14px;line-height:1.5">${order.delivery_address}${order.delivery_landmark ? ', ' + order.delivery_landmark : ''}</span>
      </td></tr>
    </table>` : ''}

    <p style="margin:0 0 4px;font-size:14px;color:#4b5563;line-height:1.6;text-align:center">
      Our decorator will be assigned shortly and will arrive at your selected time slot.
    </p>
  </td></tr>`),
    })
  } catch (e) {
    console.error('[Resend] Order booked email failed:', e.message)
  }
}

// ── Payment Receipt Email ───────────────────────────────────
export async function sendPaymentReceiptEmail(name, email, payment, order, orderType) {
  if (!resend || !email) return
  const isGift = orderType === 'gift'
  const orderId = (payment.order_id || payment.id).slice(0, 8).toUpperCase()
  const total = order ? (order.total_cost || order.gift_total || 0) : payment.amount
  const isFullPayment = isGift || (order && order.payment_status === 'full')
  const paidSoFar = (order?.payment_amount || 0)
  const remaining = isGift ? 0 : Math.max(0, total - paidSoFar)

  let paymentLabel, paymentPhase
  if (isGift) {
    paymentLabel = 'Full Payment (100%)'
    paymentPhase = 'Full payment received'
  } else if (remaining <= 0) {
    paymentLabel = 'Final Payment (50%)'
    paymentPhase = 'All payments complete'
  } else {
    paymentLabel = 'Booking Payment (50%)'
    paymentPhase = '50% remaining after decoration'
  }

  const dateStr = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })
  const timeStr = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })

  try {
    await resend.emails.send({
      from: 'FatafatDecor <receipts@mail.fatafatdecor.com>',
      to: email,
      subject: `Payment Receipt — Rs.${payment.amount} | #${orderId}`,
      html: emailWrap(`
  <tr><td style="padding:32px 32px 28px">
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px">
      <tr><td>
        <h2 style="margin:0 0 4px;font-size:22px;color:#1f2937">Payment Receipt</h2>
        <p style="margin:0;font-size:13px;color:#9ca3af">${dateStr} at ${timeStr}</p>
      </td>
      <td style="text-align:right;vertical-align:top">
        <span style="display:inline-block;background:#dcfce7;color:#15803d;padding:6px 14px;border-radius:20px;font-size:13px;font-weight:600">✓ Paid</span>
      </td></tr>
    </table>

    <p style="margin:0 0 24px;font-size:15px;color:#4b5563">Hi <strong>${name}</strong>, here's your payment receipt.</p>

    <!-- Receipt Details -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden">
      <tr><td style="padding:12px 16px;background:#f9fafb;font-size:13px;color:#6b7280;border-bottom:1px solid #e5e7eb">Order ID</td>
      <td style="padding:12px 16px;background:#f9fafb;font-size:14px;color:#1f2937;text-align:right;border-bottom:1px solid #e5e7eb;font-weight:600">#${orderId}</td></tr>
      <tr><td style="padding:12px 16px;font-size:13px;color:#6b7280;border-bottom:1px solid #e5e7eb">Order Type</td>
      <td style="padding:12px 16px;font-size:14px;color:#1f2937;text-align:right;border-bottom:1px solid #e5e7eb">${isGift ? '🎁 Gift Order' : '🎨 Decoration Order'}</td></tr>
      <tr><td style="padding:12px 16px;font-size:13px;color:#6b7280;border-bottom:1px solid #e5e7eb">Payment Type</td>
      <td style="padding:12px 16px;font-size:14px;color:#1f2937;text-align:right;border-bottom:1px solid #e5e7eb">${paymentLabel}</td></tr>
      <tr><td style="padding:12px 16px;font-size:13px;color:#6b7280;border-bottom:1px solid #e5e7eb">Transaction ID</td>
      <td style="padding:12px 16px;font-size:13px;color:#1f2937;text-align:right;border-bottom:1px solid #e5e7eb;word-break:break-all">${payment.razorpay_payment_id || payment.id}</td></tr>
      <tr><td style="padding:12px 16px;font-size:13px;color:#6b7280;border-bottom:1px solid #e5e7eb">Payment Method</td>
      <td style="padding:12px 16px;font-size:14px;color:#1f2937;text-align:right;border-bottom:1px solid #e5e7eb">Razorpay</td></tr>
    </table>

    <!-- Amount Box -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;background:linear-gradient(135deg,#fdf2f8,#fce7f3);border-radius:12px;overflow:hidden">
      <tr><td style="padding:14px 18px;font-size:14px;color:#4b5563">Order Total</td>
      <td style="padding:14px 18px;font-size:14px;color:#1f2937;text-align:right;font-weight:600">Rs.${total}</td></tr>
      <tr><td style="padding:14px 18px;font-size:14px;color:#4b5563;font-weight:600">Amount Paid</td>
      <td style="padding:14px 18px;font-size:18px;color:#ec4899;text-align:right;font-weight:700">Rs.${payment.amount}</td></tr>
      ${remaining > 0 ? `<tr><td style="padding:14px 18px;font-size:14px;color:#4b5563">Remaining Due</td>
      <td style="padding:14px 18px;font-size:14px;color:#ea580c;text-align:right;font-weight:600">Rs.${remaining}</td></tr>` : ''}
    </table>

    <!-- Payment Phase Indicator -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px">
      ${isGift ? `
      <tr><td style="padding:12px 16px;background:#dcfce7;border-radius:8px;text-align:center">
        <span style="color:#15803d;font-size:14px;font-weight:600">✓ ${paymentPhase} — Order is fully paid</span>
      </td></tr>` : `
      <tr><td style="padding:0 0 8px"><strong style="font-size:13px;color:#6b7280">PAYMENT PROGRESS</strong></td></tr>
      <tr><td style="padding:0">
        <table width="100%" cellpadding="0" cellspacing="0"><tr>
          <td style="width:50%;padding:10px;background:${remaining <= 0 ? '#dcfce7' : '#dcfce7'};border-radius:8px 0 0 8px;text-align:center;border-right:2px solid #fff">
            <span style="font-size:12px;color:#15803d;font-weight:600">✓ 50% at Booking</span><br/>
            <span style="font-size:11px;color:#6b7280">Paid</span>
          </td>
          <td style="width:50%;padding:10px;background:${remaining <= 0 ? '#dcfce7' : '#fef3c7'};border-radius:0 8px 8px 0;text-align:center">
            <span style="font-size:12px;color:${remaining <= 0 ? '#15803d' : '#b45309'};font-weight:600">${remaining <= 0 ? '✓' : '◯'} 50% After Decoration</span><br/>
            <span style="font-size:11px;color:#6b7280">${remaining <= 0 ? 'Paid' : 'Pending'}</span>
          </td>
        </tr></table>
      </td></tr>`}
    </table>

    <p style="margin:0;font-size:13px;color:#9ca3af;text-align:center;line-height:1.5">
      This is an auto-generated receipt. For any queries, contact us via the app.
    </p>
  </td></tr>`),
    })
  } catch (e) {
    console.error('[Resend] Payment receipt email failed:', e.message)
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
