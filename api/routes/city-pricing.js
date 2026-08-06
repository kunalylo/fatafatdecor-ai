// ════════════════════════════════════════════════════════════════════
// CITY PRICING — per-city decoration catalogue with a city markup.
//
//   pricing_cities : { id, name, markup_percent, active, sortOrder }
//   city_designs   : { id, city_id, name, description, image,
//                      base_price, markup_percent, final_price, ai }
//
// The markup can be written straight into the city NAME — "Ranchi Normal"
// means 0%, "Delhi 25%" means +25%. When the name carries such a signal it
// WINS and is written back into markup_percent on save, so a stored city is
// always self-consistent and every read is just `markup_percent`.
//
// base_price is the DECORATION price only. GST, setup/transport, platform and
// convenience fees are added downstream by lib/pricing-calc.js — never here,
// or they would be double-counted at checkout.
// ════════════════════════════════════════════════════════════════════
import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { connectToMongo } from '../db.js'
import { requireAdmin } from '../jwt.js'
import { asyncRoute } from '../helpers.js'
import { IMAGEKIT_PRIVATE_KEY } from '../config.js'

const router = Router()

// The two cities the business starts with. Seeded once, then fully admin-editable.
const SEED_CITIES = [
  { id: 'ranchi', name: 'Ranchi Normal', markup_percent: 0,  active: true, sortOrder: 0 },
  { id: 'delhi',  name: 'Delhi 25%',     markup_percent: 25, active: true, sortOrder: 1 },
]

async function ensureCities(db) {
  if (await db.collection('pricing_cities').countDocuments() === 0) {
    await db.collection('pricing_cities').insertMany(SEED_CITIES.map(c => ({ ...c, created_at: new Date() })))
  }
}

// "Ranchi Normal" -> 0 · "Delhi 25%" -> 25 · "Delhi +25 %" -> 25 · "Mumbai" -> null (no signal)
export function markupFromName(name) {
  const s = String(name || '').toLowerCase()
  const pct = s.match(/(\d+(?:\.\d+)?)\s*%/)
  if (pct) return clampMarkup(Number(pct[1]))
  if (/\bnormal\b/.test(s)) return 0
  return null
}

const clampMarkup = (n) => Math.min(500, Math.max(0, Math.round((Number(n) || 0) * 100) / 100))

// Single source of truth for what a city actually charges.
export function resolveMarkup({ name, markup_percent }) {
  const fromName = markupFromName(name)
  return fromName !== null ? fromName : clampMarkup(markup_percent)
}

export const applyMarkup = (basePrice, markupPercent) =>
  Math.round((Number(basePrice) || 0) * (1 + (Number(markupPercent) || 0) / 100))

// ── Cities ───────────────────────────────────────────────────────────
router.get('/admin/pricing-cities', requireAdmin, asyncRoute(async (req, res, ok) => {
  const db = await connectToMongo()
  await ensureCities(db)
  const cities = await db.collection('pricing_cities').find({}).sort({ sortOrder: 1, name: 1 }).toArray()
  // Design counts in one grouped pass rather than a query per city.
  const counts = await db.collection('city_designs').aggregate([
    { $group: { _id: '$city_id', n: { $sum: 1 } } },
  ]).toArray()
  const byCity = Object.fromEntries(counts.map(c => [c._id, c.n]))
  return ok(cities.map(({ _id, ...c }) => ({ ...c, design_count: byCity[c.id] || 0 })))
}))

router.post('/admin/pricing-cities', requireAdmin, asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  await ensureCities(db)
  const name = String(req.body?.name || '').trim()
  if (!name) return err('City name is required')
  const exists = await db.collection('pricing_cities').findOne({ name: { $regex: `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' } })
  if (exists) return err('A city with that name already exists')
  const city = {
    id: uuidv4(),
    name,
    markup_percent: resolveMarkup({ name, markup_percent: req.body?.markup_percent }),
    active: req.body?.active !== false,
    sortOrder: Number(req.body?.sortOrder) || await db.collection('pricing_cities').countDocuments(),
    created_at: new Date(),
  }
  await db.collection('pricing_cities').insertOne(city)
  const { _id, ...clean } = city
  return ok({ ...clean, design_count: 0 })
}))

router.put('/admin/pricing-cities/:id', requireAdmin, asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const current = await db.collection('pricing_cities').findOne({ id: req.params.id })
  if (!current) return err('City not found', 404)

  const name = req.body?.name !== undefined ? String(req.body.name).trim() : current.name
  if (!name) return err('City name is required')

  const $set = {
    name,
    markup_percent: resolveMarkup({
      name,
      markup_percent: req.body?.markup_percent !== undefined ? req.body.markup_percent : current.markup_percent,
    }),
    updated_at: new Date(),
  }
  if (req.body?.active !== undefined)    $set.active = !!req.body.active
  if (req.body?.sortOrder !== undefined) $set.sortOrder = Number(req.body.sortOrder) || 0

  await db.collection('pricing_cities').updateOne({ id: req.params.id }, { $set })

  // The city's markup defines every design's final price, so re-price them together —
  // otherwise saved designs would silently keep the OLD city markup.
  if ($set.markup_percent !== current.markup_percent) {
    const designs = await db.collection('city_designs').find({ city_id: req.params.id }).toArray()
    for (const d of designs) {
      await db.collection('city_designs').updateOne(
        { id: d.id },
        { $set: {
          markup_percent: $set.markup_percent,
          final_price: applyMarkup(d.base_price, $set.markup_percent),
          updated_at: new Date(),
        } },
      )
    }
  }

  const updated = await db.collection('pricing_cities').findOne({ id: req.params.id })
  const { _id, ...clean } = updated
  const design_count = await db.collection('city_designs').countDocuments({ city_id: req.params.id })
  return ok({ ...clean, design_count, repriced: $set.markup_percent !== current.markup_percent })
}))

router.delete('/admin/pricing-cities/:id', requireAdmin, asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const r = await db.collection('pricing_cities').deleteOne({ id: req.params.id })
  if (!r.deletedCount) return err('City not found', 404)
  // A design belongs to exactly one city — orphans would be unreachable in the UI.
  const { deletedCount } = await db.collection('city_designs').deleteMany({ city_id: req.params.id })
  return ok({ success: true, designs_deleted: deletedCount })
}))

// ── AI analysis ──────────────────────────────────────────────────────
// Prices the DECORATION only. The anchors below are the platform's own budget
// brackets, so the model lands inside a band the rest of the app understands.
const DESIGN_VISION_PROMPT = `You are the senior pricing estimator for FatafatDecor, an Indian event-decoration company (Ranchi & Delhi). You are shown ONE photo of a finished decoration setup. Price it for the Indian market, in INR.

Return ONLY a JSON object:
{
  "name": "short saleable name, max 6 words (e.g. 'Pastel Birthday Balloon Arch')",
  "description": "2-3 sentences describing what the customer gets: the elements, colours, materials and the mood. Written to sell, no pricing talk.",
  "occasion": "birthday | anniversary | wedding | baby_shower | engagement | corporate | festival | housewarming | new_year | party | dinner",
  "setup_type": "indoor | outdoor | venue",
  "complexity": "simple | standard | premium | luxury",
  "items": [{"name":"...","quantity":N,"unit_cost":N,"line_cost":N}],
  "materials_cost": N,
  "labour_cost": N,
  "setup_time_minutes": N,
  "base_price": N,
  "price_reasoning": "one sentence justifying the number"
}

HOW TO PRICE (follow exactly):
1. Itemise every visible element with realistic Indian WHOLESALE unit costs, e.g.
   latex balloon Rs 3-6 · chrome/metallic latex Rs 8-12 · 18in foil Rs 60-120 ·
   large number/letter foil Rs 150-300 · fairy/LED string (10m) Rs 120-250 ·
   backdrop stand hire Rs 400-900 · fabric drape panel Rs 250-600 ·
   artificial floral cluster Rs 150-400 · fresh rose stem Rs 15-35 ·
   neon sign hire Rs 800-2000 · ring/circle frame hire Rs 500-1200 ·
   printed banner/name cutout Rs 250-700.
2. materials_cost = sum of line_cost.
3. labour_cost: simple Rs 800-1500 · standard Rs 1500-3000 · premium Rs 3000-6000 ·
   luxury Rs 6000-15000 (2 people, travel and setup included).
4. base_price = round(materials_cost * 2 + labour_cost) to the nearest 100.
   The 2x on materials is the company's standard margin — never skip it.
5. Sanity-check base_price against these real bands and adjust if it falls outside:
   small balloon bouquet / single pillar      Rs 3,000 - 5,000
   standard room birthday (arch + backdrop)   Rs 6,000 - 12,000
   rich backdrop + florals + lights + props   Rs 15,000 - 30,000
   large hall / stage / heavy fresh florals    Rs 40,000 - 100,000
   full venue or wedding mandap                Rs 100,000 - 300,000
6. base_price must be between 3000 and 300000.

base_price is the DECORATION-ONLY price. Do NOT add GST, delivery, setup fees or platform fees — those are applied later by the system.`

const MIN_PRICE = 3000
const MAX_PRICE = 300000

// The model occasionally forgets step 4 or 6. Rebuild the number from its own itemisation
// and clamp it, so a hallucinated price can never reach the catalogue.
function reconcilePrice(a) {
  const materials = Math.max(0, Number(a.materials_cost) || 0)
  const labour    = Math.max(0, Number(a.labour_cost) || 0)
  const stated    = Math.round(Number(a.base_price) || 0)
  const derived   = Math.round((materials * 2 + labour) / 100) * 100

  let price = stated
  let note  = null
  if (!stated || stated < MIN_PRICE || stated > MAX_PRICE) {
    price = derived
    note  = `AI price ${stated || 0} out of range — rebuilt from materials x2 + labour`
  } else if (derived > 0 && Math.abs(stated - derived) / derived > 0.35) {
    // >35% off its own maths: trust the itemisation, not the headline number.
    price = derived
    note  = `AI price ${stated} disagreed with its own itemisation (${derived}) — used the itemisation`
  }
  price = Math.min(MAX_PRICE, Math.max(MIN_PRICE, Math.round(price / 100) * 100))
  return { price, note, materials, labour, derived }
}

async function ikUploadDesign(fileOrUrl, fileName) {
  if (!IMAGEKIT_PRIVATE_KEY) return null
  const auth = Buffer.from(IMAGEKIT_PRIVATE_KEY + ':').toString('base64')
  const form = new URLSearchParams()
  form.append('file', fileOrUrl)
  form.append('fileName', fileName)
  form.append('folder', '/city-designs')
  try {
    const r = await fetch('https://upload.imagekit.io/api/v1/files/upload', {
      method: 'POST',
      headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    })
    const d = await r.json()
    return d.url || null
  } catch { return null }
}

// POST /admin/city-designs/analyze — { image_base64, city_id } → priced draft (does NOT save)
router.post('/admin/city-designs/analyze', requireAdmin, asyncRoute(async (req, res, ok, err) => {
  const { image_base64, city_id } = req.body || {}
  if (!image_base64) return err('image_base64 required')
  const OPENAI_KEY = process.env.OPENAI_API_KEY
  if (!OPENAI_KEY) return err('OPENAI_API_KEY not configured', 500)

  const db = await connectToMongo()
  await ensureCities(db)
  const city = city_id ? await db.collection('pricing_cities').findOne({ id: city_id }) : null
  if (city_id && !city) return err('City not found', 404)
  const markup = city ? resolveMarkup(city) : 0

  const imgData = image_base64.startsWith('data:') ? image_base64 : `data:image/jpeg;base64,${image_base64}`

  const [imageUrl, visionResp] = await Promise.all([
    ikUploadDesign(image_base64, `design_${Date.now()}.jpg`),
    fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o',
        response_format: { type: 'json_object' },
        max_tokens: 1600,
        temperature: 0.2,          // pricing should be repeatable, not creative
        messages: [
          { role: 'system', content: DESIGN_VISION_PROMPT },
          { role: 'user', content: [{ type: 'image_url', image_url: { url: imgData } }] },
        ],
      }),
    }).then(r => r.json()).catch(e => ({ _error: e.message })),
  ])

  if (visionResp?._error)              return err(`AI request failed: ${visionResp._error}`, 502)
  if (visionResp?.error?.message)      return err(`AI error: ${visionResp.error.message}`, 502)
  const content = visionResp?.choices?.[0]?.message?.content
  if (!content) return err('AI analysis failed — no response', 502)

  let a
  try { a = JSON.parse(content) } catch { return err('AI returned invalid JSON', 502) }

  const { price: basePrice, note, materials, labour, derived } = reconcilePrice(a)

  return ok({
    name:        String(a.name || 'Untitled Decoration').slice(0, 90),
    description: String(a.description || '').slice(0, 600),
    occasion:    a.occasion || '',
    setup_type:  a.setup_type || '',
    complexity:  a.complexity || '',
    items:       Array.isArray(a.items) ? a.items.slice(0, 40) : [],
    materials_cost: materials,
    labour_cost:    labour,
    setup_time_minutes: Number(a.setup_time_minutes) || 0,
    price_reasoning: String(a.price_reasoning || '').slice(0, 300),
    image: imageUrl || '',
    // Pricing, spelled out so the admin can see exactly how the number was reached
    base_price:     basePrice,          // the "normal", best price
    markup_percent: markup,
    final_price:    applyMarkup(basePrice, markup),
    city_id:        city?.id || null,
    city_name:      city?.name || '',
    derived_price:  derived,
    price_note:     note,
  })
}))

// ── Designs ──────────────────────────────────────────────────────────
router.get('/admin/city-designs', requireAdmin, asyncRoute(async (req, res, ok) => {
  const db = await connectToMongo()
  const q = req.query.city_id ? { city_id: req.query.city_id } : {}
  const designs = await db.collection('city_designs').find(q).sort({ created_at: -1 }).toArray()
  return ok(designs.map(({ _id, ...d }) => d))
}))

router.post('/admin/city-designs', requireAdmin, asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const b = req.body || {}
  const name = String(b.name || '').trim()
  if (!name)      return err('Design name is required')
  if (!b.city_id) return err('city_id is required')

  const city = await db.collection('pricing_cities').findOne({ id: b.city_id })
  if (!city) return err('City not found', 404)

  const basePrice = Math.round(Number(b.base_price) || 0)
  if (basePrice < MIN_PRICE || basePrice > MAX_PRICE) {
    return err(`Base price must be between ${MIN_PRICE} and ${MAX_PRICE}`)
  }
  // Markup always comes from the city, never the client — otherwise a stale form could
  // save a design priced off a markup the city no longer has.
  const markup = resolveMarkup(city)

  const design = {
    id: uuidv4(),
    city_id: city.id,
    city_name: city.name,
    name,
    description: String(b.description || '').trim().slice(0, 600),
    image: String(b.image || '').trim(),
    occasion: b.occasion || '',
    setup_type: b.setup_type || '',
    complexity: b.complexity || '',
    base_price: basePrice,
    markup_percent: markup,
    final_price: applyMarkup(basePrice, markup),
    ai: b.ai || null,
    active: b.active !== false,
    created_at: new Date(),
  }
  await db.collection('city_designs').insertOne(design)
  const { _id, ...clean } = design
  return ok(clean)
}))

router.put('/admin/city-designs/:id', requireAdmin, asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const current = await db.collection('city_designs').findOne({ id: req.params.id })
  if (!current) return err('Design not found', 404)
  const b = req.body || {}

  const $set = { updated_at: new Date() }
  if (b.name !== undefined) {
    const name = String(b.name).trim()
    if (!name) return err('Design name is required')
    $set.name = name
  }
  if (b.description !== undefined) $set.description = String(b.description).slice(0, 600)
  if (b.image !== undefined)       $set.image = String(b.image).trim()
  if (b.occasion !== undefined)    $set.occasion = b.occasion
  if (b.active !== undefined)      $set.active = !!b.active

  // Re-price whenever the base price OR the owning city changes.
  let city = null
  if (b.city_id && b.city_id !== current.city_id) {
    city = await db.collection('pricing_cities').findOne({ id: b.city_id })
    if (!city) return err('City not found', 404)
    $set.city_id = city.id
    $set.city_name = city.name
  }
  const effectiveCity = city || await db.collection('pricing_cities').findOne({ id: current.city_id })
  const markup = effectiveCity ? resolveMarkup(effectiveCity) : (current.markup_percent || 0)

  const basePrice = b.base_price !== undefined ? Math.round(Number(b.base_price) || 0) : current.base_price
  if (basePrice < MIN_PRICE || basePrice > MAX_PRICE) {
    return err(`Base price must be between ${MIN_PRICE} and ${MAX_PRICE}`)
  }
  $set.base_price     = basePrice
  $set.markup_percent = markup
  $set.final_price    = applyMarkup(basePrice, markup)

  await db.collection('city_designs').updateOne({ id: req.params.id }, { $set })
  const updated = await db.collection('city_designs').findOne({ id: req.params.id })
  const { _id, ...clean } = updated
  return ok(clean)
}))

router.delete('/admin/city-designs/:id', requireAdmin, asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const r = await db.collection('city_designs').deleteOne({ id: req.params.id })
  if (!r.deletedCount) return err('Design not found', 404)
  return ok({ success: true })
}))

export default router
