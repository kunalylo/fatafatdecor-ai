import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { connectToMongo } from '../db.js'
import { requireAdmin } from '../jwt.js'
import { hashPwd, asyncRoute } from '../helpers.js'
import { IMAGEKIT_PRIVATE_KEY } from '../config.js'

const router = Router()

// All admin routes require admin JWT (scoped to /admin/* paths only)
router.use('/admin', requireAdmin)

// POST /admin/block-slot
router.post('/admin/block-slot', asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const { date, hour, blocked } = req.body
  if (!date || hour === undefined) return err('date and hour required')
  if (blocked) {
    await db.collection('blocked_slots').updateOne({ date, hour }, { $set: { date, hour, blocked: true, updated_at: new Date() } }, { upsert: true })
  } else {
    await db.collection('blocked_slots').deleteOne({ date, hour })
  }
  return ok({ success: true, date, hour, blocked })
}))

// GET /admin/blocked-slots
router.get('/admin/blocked-slots', asyncRoute(async (req, res, ok, err) => {
  const db   = await connectToMongo()
  const date = req.query.date
  if (!date) return err('date required')
  const blocked = await db.collection('blocked_slots').find({ date }).toArray()
  return ok({ date, blocked_hours: blocked.map(b => b.hour) })
}))

// ── Sub-admins CRUD ────────────────────────────────────────────

// GET /admin/sub-admins
router.get('/admin/sub-admins', asyncRoute(async (req, res, ok) => {
  const db   = await connectToMongo()
  const subs = await db.collection('users').find({ role: 'sub_admin' }).sort({ created_at: -1 }).toArray()
  return ok(subs.map(({ _id, password, ...u }) => u))
}))

// POST /admin/sub-admins
router.post('/admin/sub-admins', asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const { name, email, password, permissions } = req.body
  if (!name || !email || !password) return err('Name, email, password required')
  const existing = await db.collection('users').findOne({ email })
  if (existing) return err('Email already registered')
  const sub = { id: uuidv4(), name, email, phone: '', password: hashPwd(password), role: 'sub_admin', permissions: permissions || [], credits: 0, has_purchased_credits: false, location: null, auth_provider: 'email', created_at: new Date() }
  await db.collection('users').insertOne(sub)
  const { _id, password: _, ...safe } = sub
  return ok(safe)
}))

// PUT /admin/sub-admins/:id
router.put('/admin/sub-admins/:id', asyncRoute(async (req, res, ok, err) => {
  const db   = await connectToMongo()
  const body = req.body; delete body._id; delete body.password; body.updated_at = new Date()
  await db.collection('users').updateOne({ id: req.params.id, role: 'sub_admin' }, { $set: body })
  const sub = await db.collection('users').findOne({ id: req.params.id })
  if (!sub) return err('Sub-admin not found', 404)
  const { _id, password, ...safe } = sub
  return ok(safe)
}))

// DELETE /admin/sub-admins/:id
router.delete('/admin/sub-admins/:id', asyncRoute(async (req, res, ok) => {
  const db = await connectToMongo()
  await db.collection('users').deleteOne({ id: req.params.id, role: 'sub_admin' })
  return ok({ success: true })
}))

// ── Admin Users (customers) ────────────────────────────────────

// GET /admin/users
router.get('/admin/users', asyncRoute(async (req, res, ok) => {
  const db     = await connectToMongo()
  const search = req.query.search || ''
  const query  = { role: { $in: ['user', 'admin'] } }
  if (search) query.$or = [
    { name:  { $regex: search, $options: 'i' } },
    { email: { $regex: search, $options: 'i' } },
    { phone: { $regex: search, $options: 'i' } },
  ]
  const users = await db.collection('users').find(query).sort({ created_at: -1 }).limit(100).toArray()
  return ok(users.map(({ _id, password, ...u }) => u))
}))

// PUT /admin/users/:id
router.put('/admin/users/:id', asyncRoute(async (req, res, ok, err) => {
  const db   = await connectToMongo()
  const body = req.body; delete body._id; delete body.password
  if (body.new_password) { body.password = hashPwd(body.new_password); delete body.new_password }
  await db.collection('users').updateOne({ id: req.params.id }, { $set: body })
  const u = await db.collection('users').findOne({ id: req.params.id })
  if (!u) return err('User not found', 404)
  const { _id, password, ...safe } = u
  return ok(safe)
}))

// DELETE /admin/users/:id
router.delete('/admin/users/:id', asyncRoute(async (req, res, ok) => {
  const db = await connectToMongo()
  await db.collection('users').deleteOne({ id: req.params.id })
  await db.collection('orders').deleteMany({ user_id: req.params.id })
  await db.collection('designs').deleteMany({ user_id: req.params.id })
  await db.collection('gift_orders').deleteMany({ user_id: req.params.id })
  await db.collection('payments').deleteMany({ user_id: req.params.id })
  return ok({ success: true })
}))

// ── Admin DP toggle ────────────────────────────────────────────

// POST /admin/dp-toggle
router.post('/admin/dp-toggle', asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const { dp_id } = req.body
  const dp = await db.collection('delivery_persons').findOne({ id: dp_id })
  if (!dp) return err('Decorator not found', 404)
  const newStatus = !dp.is_active
  await db.collection('delivery_persons').updateOne({ id: dp_id }, { $set: { is_active: newStatus } })
  return ok({ success: true, is_active: newStatus })
}))

// ── Admin Orders ───────────────────────────────────────────────

// GET /admin/orders — all orders
router.get('/admin/orders', asyncRoute(async (req, res, ok) => {
  const db = await connectToMongo()
  const orders = await db.collection('orders').find({}).sort({ created_at: -1 }).toArray()
  return ok(orders.map(({ _id, ...o }) => o))
}))

// PUT /admin/orders/:id  (admin full update)
router.put('/admin/orders/:id', asyncRoute(async (req, res, ok, err) => {
  const db   = await connectToMongo()
  const body = req.body; delete body._id
  await db.collection('orders').updateOne({ id: req.params.id }, { $set: body })
  const o = await db.collection('orders').findOne({ id: req.params.id })
  if (!o) return err('Order not found', 404)
  const { _id, ...clean } = o
  return ok(clean)
}))

// ── AI Gift Auto-Fill ─────────────────────────────────────────

const GIFT_VISION_PROMPT = `You are a gift product analyst for an Indian e-commerce decoration and gifting platform. Analyze the uploaded gift/product image and return a JSON object with exactly these fields:
{
  "name": "concise product name (e.g. 'Premium Chocolate Gift Hamper', 'Red Rose Bouquet')",
  "description": "2-3 sentence appealing product description mentioning key features and materials",
  "category": "one of: Flowers, Cakes, Chocolates, Hampers, Toys, Home Decor, Accessories, Candles, Soft Toys, Personalized, Other",
  "colour": "dominant hex color code (e.g. '#ff69b4')",
  "occasion": "most suitable: Birthday, Wedding, Anniversary, Diwali, Christmas, Valentine, Housewarming, Rakhi, General",
  "price": estimated_retail_price_in_INR_as_integer,
  "item_count": number_of_distinct_items_visible,
  "items": [{"name": "item name", "visual_description": "detailed visual description for image generation"}],
  "full_visual_description": "very detailed visual description including colors, materials, textures, shapes, sizes, arrangement, packaging"
}
Price guide (INR): Flowers 300-2500, Cakes 400-2000, Chocolates 200-1500, Hampers 500-5000, Soft toys 300-2000, Decor 200-3000.`

function buildGiftImagePrompts(analysis) {
  const desc = analysis.full_visual_description || analysis.description || analysis.name
  const items = analysis.items || []
  const occasion = analysis.occasion || 'celebration'
  let prompts = []
  if ((analysis.item_count || 1) <= 1 || items.length <= 1) {
    prompts = [
      `Professional e-commerce product photo of ${desc}, front view, clean white background, studio lighting, high resolution`,
      `Professional product photo of ${desc}, 45-degree angle view, clean white background, soft studio lighting`,
      `Top-down flat lay product photo of ${desc}, white background, overhead birds-eye view, studio lighting`,
      `Close-up detail macro shot of ${desc}, shallow depth of field, studio photography, showing textures`,
      `${desc} elegantly gift-wrapped with satin ribbon and bow, professional product photo, white background`,
      `Lifestyle product photo of ${desc} in a cozy decorated home setting, natural warm lighting`,
      `${desc} displayed on a boutique shelf or pedestal, premium presentation, soft bokeh background`,
      `Professional product photo of ${desc} held in hand showing scale, natural lighting`,
      `${desc} in a festive ${occasion} themed setting with decorations, warm celebratory mood lighting`,
    ]
  } else {
    const itemPrompts = items.slice(0, 5).map(it =>
      `Professional e-commerce product photo of single isolated ${it.visual_description || it.name}, clean white background, studio lighting, centered`
    )
    const extras = [
      `Top-down flat lay of all items: ${desc}, neatly organized, white background, studio lighting`,
      `${desc} arranged as gift hamper with ribbon, professional product photo, white background`,
      `Lifestyle photo of ${desc} on a table in a cozy room, natural warm lighting`,
      `Close-up detail shot of ${desc}, showing quality and textures, shallow depth of field`,
      `${desc} in a festive ${occasion} themed display, warm mood lighting`,
    ].slice(0, 9 - itemPrompts.length)
    prompts = [...itemPrompts, ...extras]
  }
  while (prompts.length < 9) prompts.push(`Professional product photo of ${desc}, clean background, studio lighting`)
  return prompts.slice(0, 9)
}

async function ikUpload(fileOrUrl, fileName) {
  const auth = Buffer.from(IMAGEKIT_PRIVATE_KEY + ':').toString('base64')
  const form = new URLSearchParams()
  form.append('file', fileOrUrl)
  form.append('fileName', fileName)
  form.append('folder', '/gifts')
  try {
    const r = await fetch('https://upload.imagekit.io/api/v1/files/upload', {
      method: 'POST',
      headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString()
    })
    const d = await r.json()
    return d.url || null
  } catch { return null }
}

router.post('/admin/gifts/ai-fill', asyncRoute(async (req, res, ok, err) => {
  const { image_base64 } = req.body
  if (!image_base64) return err('image_base64 required')
  const OPENAI_KEY = process.env.OPENAI_API_KEY
  const FAL_KEY_VAL = process.env.FAL_KEY
  if (!OPENAI_KEY) return err('OPENAI_API_KEY not configured', 500)
  if (!FAL_KEY_VAL) return err('FAL_KEY not configured', 500)
  if (!IMAGEKIT_PRIVATE_KEY) return err('IMAGEKIT_PRIVATE_KEY not configured', 500)

  const imgData = image_base64.startsWith('data:') ? image_base64 : `data:image/jpeg;base64,${image_base64}`

  const [originalUrl, visionResp] = await Promise.all([
    ikUpload(image_base64, `gift_orig_${Date.now()}.jpg`),
    fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o', response_format: { type: 'json_object' }, max_tokens: 1000,
        messages: [
          { role: 'system', content: GIFT_VISION_PROMPT },
          { role: 'user', content: [{ type: 'image_url', image_url: { url: imgData } }] }
        ]
      })
    }).then(r => r.json())
  ])

  if (!visionResp.choices?.[0]?.message?.content) return err('AI analysis failed', 500)
  let analysis
  try { analysis = JSON.parse(visionResp.choices[0].message.content) } catch { return err('AI returned invalid data', 500) }

  const prompts = buildGiftImagePrompts(analysis)
  const falResults = await Promise.allSettled(
    prompts.map(prompt =>
      fetch('https://fal.run/fal-ai/flux/schnell', {
        method: 'POST',
        headers: { 'Authorization': `Key ${FAL_KEY_VAL}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, image_size: 'square_hd', num_images: 1, num_inference_steps: 4, output_format: 'jpeg' })
      }).then(r => r.json()).then(d => d.images?.[0]?.url)
    )
  )
  const falUrls = falResults.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value)

  const uploadResults = await Promise.allSettled(
    falUrls.map((url, i) => ikUpload(url, `gift_ai_${Date.now()}_${i}.jpg`))
  )
  const uploadedUrls = uploadResults.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value)

  const images = [originalUrl, ...uploadedUrls].filter(Boolean).slice(0, 10)
  return ok({
    name: analysis.name || 'Untitled Gift',
    description: analysis.description || '',
    price: analysis.price || 0,
    stock: 100,
    category: analysis.category || '',
    colour: analysis.colour || '#ff69b4',
    occasion: analysis.occasion || '',
    images,
    image_url: images[0] || ''
  })
}))

// ── Admin Gifts CRUD ──────────────────────────────────────────

// GET /admin/gifts — all gifts (including inactive)
router.get('/admin/gifts', asyncRoute(async (req, res, ok) => {
  const db = await connectToMongo()
  const gifts = await db.collection('gifts').find({}).sort({ name: 1 }).toArray()
  return ok(gifts.map(({ _id, ...g }) => g))
}))

// POST /admin/gifts — create gift
router.post('/admin/gifts', asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const { name, description, price, images, image_url, stock, category, colour, occasion } = req.body
  if (!name) return err('Gift name required')
  const imgArr = Array.isArray(images) ? images : []
  const gift = {
    id: uuidv4(), name, description: description || '',
    price: Number(price) || 0,
    images: imgArr, image_url: imgArr[0] || image_url || '',
    stock: Number(stock) || 0, category: category || '', colour: colour || '',
    occasion: occasion || '', active: true, is_active: true, created_at: new Date()
  }
  await db.collection('gifts').insertOne(gift)
  const { _id, ...clean } = gift
  return ok(clean)
}))

// PUT /admin/gifts/:id — update gift
router.put('/admin/gifts/:id', asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const body = req.body; delete body._id
  if (body.price !== undefined) body.price = Number(body.price)
  if (body.stock !== undefined) body.stock = Number(body.stock)
  if (body.active !== undefined) body.is_active = body.active
  if (Array.isArray(body.images)) body.image_url = body.images[0] || ''
  body.updated_at = new Date()
  await db.collection('gifts').updateOne({ id: req.params.id }, { $set: body })
  const gift = await db.collection('gifts').findOne({ id: req.params.id })
  if (!gift) return err('Gift not found', 404)
  const { _id, ...clean } = gift
  return ok(clean)
}))

// DELETE /admin/gifts/:id — delete gift
router.delete('/admin/gifts/:id', asyncRoute(async (req, res, ok) => {
  const db = await connectToMongo()
  await db.collection('gifts').deleteOne({ id: req.params.id })
  return ok({ success: true })
}))

// GET /admin/gift-orders — all gift orders
router.get('/admin/gift-orders', asyncRoute(async (req, res, ok) => {
  const db = await connectToMongo()
  const orders = await db.collection('gift_orders').find({}).sort({ created_at: -1 }).toArray()
  return ok(orders.map(({ _id, ...o }) => o))
}))

// PUT /admin/gift-orders/:id — update gift order status
router.put('/admin/gift-orders/:id', asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const body = req.body; delete body._id
  body.updated_at = new Date()
  await db.collection('gift_orders').updateOne({ id: req.params.id }, { $set: body })
  const order = await db.collection('gift_orders').findOne({ id: req.params.id })
  if (!order) return err('Gift order not found', 404)
  const { _id, ...clean } = order
  return ok(clean)
}))

export default router
