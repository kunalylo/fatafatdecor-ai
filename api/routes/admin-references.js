// /admin/references/* — Reference Designs (decoration photos curated by admin).
// Pipeline: filename parse → ImageKit upload → gpt-4o vision → SKU match → pricing → save.

import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import multer from 'multer'
import { connectToMongo } from '../db.js'
import { requireAdmin } from '../jwt.js'
import { asyncRoute } from '../helpers.js'
import { AI_SERVICE_URL, IMAGEKIT_PRIVATE_KEY } from '../config.js'
import { parseFilename } from '../lib/filename-parser.js'

const router = Router()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } })

router.use('/admin/references', requireAdmin)

// ── Helpers ─────────────────────────────────────────────────────

async function uploadToImageKit(buffer, filename) {
  if (!IMAGEKIT_PRIVATE_KEY) throw new Error('IMAGEKIT_PRIVATE_KEY not configured')
  const base64 = buffer.toString('base64')
  const ikAuth = Buffer.from(IMAGEKIT_PRIVATE_KEY + ':').toString('base64')
  const body = new URLSearchParams()
  body.append('file', base64)
  body.append('fileName', filename)
  body.append('folder', '/references')
  const res = await fetch('https://upload.imagekit.io/api/v1/files/upload', {
    method: 'POST',
    headers: { 'Authorization': `Basic ${ikAuth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  const data = await res.json()
  if (!data.url) throw new Error('ImageKit upload failed: ' + JSON.stringify(data))
  return {
    image_url:     data.url,
    thumbnail_url: data.url + '?tr=w-400,c-maintain_ratio',
    file_id:       data.fileId,
  }
}

async function callFastAPI(endpoint, body) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 120000)
  try {
    const res = await fetch(`${AI_SERVICE_URL}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    clearTimeout(t)
    return await res.json()
  } catch (e) {
    clearTimeout(t)
    throw e
  }
}

// Look up the best SKU candidates for a detected item, then ask Gemini to pick the best match.
async function findBestSkuMatch(db, detection) {
  // Build filter from detection
  const filter = { active: true }
  const type = detection.type || ''

  if (type === 'latex_balloon') filter.category = 'Latex Balloons'
  else if (type === 'foil_balloon') filter.category = 'Foil Balloons'

  if (detection.color)  filter.color  = { $regex: `^${detection.color}$`, $options: 'i' }
  if (detection.finish) filter.finish = { $regex: detection.finish, $options: 'i' }
  if (detection.size_inches) {
    // Allow ±2 inch tolerance for size matching
    const s = Number(detection.size_inches)
    filter.size_inches = { $gte: s - 2, $lte: s + 2 }
  }

  let candidates = await db.collection('master_inventory').find(filter).limit(20).toArray()

  // Widen if no candidates: drop size, then drop finish, then drop color
  if (candidates.length === 0) {
    delete filter.size_inches
    candidates = await db.collection('master_inventory').find(filter).limit(20).toArray()
  }
  if (candidates.length === 0) {
    delete filter.finish
    candidates = await db.collection('master_inventory').find(filter).limit(20).toArray()
  }
  if (candidates.length === 0) {
    delete filter.color
    candidates = await db.collection('master_inventory').find(filter).limit(20).toArray()
  }
  if (candidates.length === 0) return null

  // Ask Gemini to pick best
  const slim = candidates.map(c => ({
    sku_code: c.sku_code,
    category: c.category,
    subcategory: c.subcategory,
    color: c.color,
    finish: c.finish,
    size_inches: c.size_inches,
    shape: c.shape,
    per_unit_cost: c.per_unit_cost,
    selling_price_per_unit: c.selling_price_per_unit,
  }))

  const match = await callFastAPI('/match-skus', {
    detection,
    candidates: slim,
  })

  if (!match.success || !match.matched_sku_code) {
    // Fallback: pick first candidate
    const fallback = candidates[0]
    return {
      sku: fallback,
      confidence: 'low',
      reasoning: 'auto-picked first candidate (Gemini match failed)',
    }
  }

  const matchedSku = candidates.find(c => c.sku_code === match.matched_sku_code) || candidates[0]
  return {
    sku: matchedSku,
    confidence: match.confidence || 'medium',
    reasoning: match.reasoning || '',
  }
}

// Run the full AI pipeline on a reference doc (called in background).
async function runReferencePipeline(referenceId) {
  const db  = await connectToMongo()
  const ref = await db.collection('reference_designs').findOne({ id: referenceId })
  if (!ref) return

  try {
    // 1. Detect items with gpt-4o vision
    const detection = await callFastAPI('/detect-items', { image_url: ref.image_url })
    if (!detection.success) throw new Error('Vision detection failed: ' + (detection.error || 'unknown'))

    if (detection.is_screenshot) {
      await db.collection('reference_designs').updateOne(
        { id: referenceId },
        { $set: {
          status: 'rejected',
          rejection_reason: 'Image appears to be a screenshot, not a real decoration photo',
          updated_at: new Date(),
        }},
      )
      return
    }

    // 2. Match each detected item to an SKU
    const detectedItems = []
    let itemsCostTotal  = 0
    let itemsPriceTotal = 0

    for (const det of (detection.items || [])) {
      const match = await findBestSkuMatch(db, det)
      const qty   = Math.max(1, Number(det.quantity) || 1)

      if (match) {
        const lineCost  = (match.sku.per_unit_cost || 0)          * qty
        const linePrice = (match.sku.selling_price_per_unit || 0) * qty
        itemsCostTotal  += lineCost
        itemsPriceTotal += linePrice

        detectedItems.push({
          raw_detection:    `${qty}x ${det.color || ''} ${det.finish || ''} ${det.type || ''} ${det.size_inches || ''}"`.replace(/\s+/g, ' ').trim(),
          matched_sku_code: match.sku.sku_code,
          matched_sku_id:   match.sku.id,
          sku_name:         `${match.sku.color} ${match.sku.subcategory} ${match.sku.size_inches}"`.trim(),
          category:         match.sku.category,
          quantity:         qty,
          unit_cost:        match.sku.per_unit_cost || 0,
          unit_price:       match.sku.selling_price_per_unit || 0,
          line_cost:        lineCost,
          line_price:       linePrice,
          confidence:       match.confidence,
          reasoning:        match.reasoning,
          is_removable:     det.type === 'light' || det.subtype === 'led_curtain',
          raw: det,
        })
      } else {
        // No SKU match — keep as unmatched for admin review
        detectedItems.push({
          raw_detection:    `${qty}x ${det.color || ''} ${det.finish || ''} ${det.type || ''}`.trim(),
          matched_sku_code: null,
          matched_sku_id:   null,
          sku_name:         `[UNMATCHED] ${det.color} ${det.finish} ${det.type}`,
          category:         det.type,
          quantity:         qty,
          unit_cost:        0,
          unit_price:       0,
          line_cost:        0,
          line_price:       0,
          confidence:       'low',
          reasoning:        'No matching SKU found in master_inventory',
          is_removable:     false,
          raw: det,
        })
      }
    }

    // 3. Pricing: service_charge = base_price - items_price_total
    const basePrice = Number(ref.base_price) || 0
    const serviceCharge = Math.max(0, basePrice - itemsPriceTotal)

    // 4. Generate tags
    const itemsSummary = detectedItems
      .map(i => `${i.quantity}x ${i.sku_name}`)
      .slice(0, 10)
      .join(', ')
    const tagsRes = await callFastAPI('/generate-tags', {
      occasion: ref.occasion || '',
      theme: ref.theme || '',
      setup_type: ref.setup_type || '',
      detected_items_summary: itemsSummary,
    })

    // 5. Update reference doc
    const marginValue = basePrice - itemsCostTotal
    const marginPct = basePrice > 0 ? (marginValue / basePrice) * 100 : 0

    await db.collection('reference_designs').updateOne(
      { id: referenceId },
      { $set: {
        status: 'pending_review',
        detected_items: detectedItems,
        items_cost_total:    Math.round(itemsCostTotal * 100) / 100,
        items_price_total:   Math.round(itemsPriceTotal * 100) / 100,
        service_charge:      Math.round(serviceCharge * 100) / 100,
        estimated_margin:    Math.round(marginValue * 100) / 100,
        margin_percent:      Math.round(marginPct * 10) / 10,
        ai_tags:             tagsRes.tags || [],
        ai_color_palette:    detection.color_palette || [],
        ai_dominant_mood:    detection.dominant_mood || '',
        setup_complexity:    detection.setup_complexity || 'medium',
        estimated_setup_minutes: detection.estimated_setup_minutes || 60,
        updated_at: new Date(),
      }},
    )
  } catch (e) {
    console.error('[reference-pipeline]', referenceId, e)
    await db.collection('reference_designs').updateOne(
      { id: referenceId },
      { $set: {
        status: 'error',
        rejection_reason: 'Pipeline failed: ' + e.message,
        updated_at: new Date(),
      }},
    )
  }
}

// ── Routes ─────────────────────────────────────────────────────

// POST /admin/references/upload — single image upload
router.post('/admin/references/upload', upload.single('file'), asyncRoute(async (req, res, ok, err) => {
  if (!req.file) return err('No file uploaded (field name: file)')

  const db = await connectToMongo()
  const originalName = req.body.filename || req.file.originalname || 'untitled.jpg'
  const parsed = parseFilename(originalName)

  // Use provided overrides if admin set them in the form
  const basePrice = Number(req.body.base_price) || parsed.price || 0
  const occasion  = String(req.body.occasion  || parsed.occasion || '').toLowerCase()
  const theme     = String(req.body.theme     || parsed.theme    || '')
  const setupType = String(req.body.setup_type|| parsed.setup_type || '')

  if (!basePrice) return err('Could not determine base price from filename. Pass base_price in form data.', 400)

  const referenceId = uuidv4()

  // Upload to ImageKit
  let ikData
  try {
    ikData = await uploadToImageKit(req.file.buffer, `ref_${referenceId}.jpg`)
  } catch (e) {
    return err('Image upload failed: ' + e.message, 500)
  }

  // Save initial doc
  const doc = {
    id: referenceId,
    image_url:     ikData.image_url,
    thumbnail_url: ikData.thumbnail_url,
    imagekit_file_id: ikData.file_id || null,
    raw_filename:  originalName,
    base_price:    basePrice,
    occasion,
    theme,
    setup_type:    setupType,
    room_hint:     parsed.room_hint || null,

    // Pipeline outputs (filled in by background task)
    detected_items: [],
    items_cost_total: 0,
    items_price_total: 0,
    service_charge: 0,
    estimated_margin: 0,
    margin_percent: 0,
    ai_tags: [],
    ai_color_palette: [],
    ai_dominant_mood: '',
    setup_complexity: 'medium',
    estimated_setup_minutes: 60,

    // Stats
    use_count: 0,
    view_count: 0,
    conversion_rate: 0,

    // Workflow
    status: 'processing',
    active: false,
    uploaded_by: req.adminId,
    approved_by: null,
    approved_at: null,
    rejection_reason: null,

    created_at: new Date(),
    updated_at: new Date(),
  }
  await db.collection('reference_designs').insertOne(doc)

  // Fire-and-forget pipeline (admin can poll/refresh to see updates)
  runReferencePipeline(referenceId).catch(e => console.error('[pipeline bg]', e))

  const { _id, ...clean } = doc
  return ok(clean)
}))

// POST /admin/references/:id/rerun — re-run the AI pipeline (e.g., after SKU import)
router.post('/admin/references/:id/rerun', asyncRoute(async (req, res, ok, err) => {
  const db  = await connectToMongo()
  const ref = await db.collection('reference_designs').findOne({ id: req.params.id })
  if (!ref) return err('Reference not found', 404)

  await db.collection('reference_designs').updateOne(
    { id: req.params.id },
    { $set: { status: 'processing', updated_at: new Date() } },
  )
  runReferencePipeline(req.params.id).catch(e => console.error('[pipeline bg]', e))
  return ok({ id: req.params.id, status: 'processing' })
}))

// GET /admin/references — list with filters
router.get('/admin/references', asyncRoute(async (req, res, ok) => {
  const db = await connectToMongo()
  const { occasion, status, theme, page = 1, limit = 30, sort = 'recent' } = req.query

  const filter = {}
  if (occasion) filter.occasion = occasion
  if (status)   filter.status   = status
  if (theme)    filter.theme    = { $regex: theme, $options: 'i' }

  const sortMap = {
    recent:    { created_at: -1 },
    popular:   { use_count:  -1 },
    price_asc: { base_price:  1 },
    price_desc:{ base_price: -1 },
    margin:    { margin_percent: -1 },
  }

  const pageNum  = Math.max(1, Number(page))
  const limitNum = Math.min(100, Math.max(1, Number(limit)))
  const skip     = (pageNum - 1) * limitNum

  const [items, total] = await Promise.all([
    db.collection('reference_designs')
      .find(filter)
      .sort(sortMap[sort] || sortMap.recent)
      .skip(skip)
      .limit(limitNum)
      .toArray(),
    db.collection('reference_designs').countDocuments(filter),
  ])

  return ok({
    references: items.map(({ _id, ...r }) => r),
    total,
    page: pageNum,
    limit: limitNum,
    pages: Math.ceil(total / limitNum),
  })
}))

// GET /admin/references/:id
router.get('/admin/references/:id', asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const ref = await db.collection('reference_designs').findOne({ id: req.params.id })
  if (!ref) return err('Reference not found', 404)
  const { _id, ...clean } = ref
  return ok(clean)
}))

// PUT /admin/references/:id — admin edits any field
router.put('/admin/references/:id', asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const updates = { ...req.body, updated_at: new Date() }
  delete updates._id
  delete updates.id
  delete updates.created_at

  // If detected_items changed, recompute totals
  if (Array.isArray(updates.detected_items)) {
    let cost = 0, price = 0
    for (const i of updates.detected_items) {
      cost  += (Number(i.unit_cost)  || 0) * (Number(i.quantity) || 1)
      price += (Number(i.unit_price) || 0) * (Number(i.quantity) || 1)
    }
    updates.items_cost_total  = Math.round(cost  * 100) / 100
    updates.items_price_total = Math.round(price * 100) / 100

    // Recalculate service charge if base_price exists
    const ref = await db.collection('reference_designs').findOne({ id: req.params.id })
    const basePrice = Number(updates.base_price ?? ref?.base_price ?? 0)
    updates.service_charge = Math.max(0, basePrice - updates.items_price_total)
    updates.estimated_margin = basePrice - updates.items_cost_total
    updates.margin_percent = basePrice > 0 ? Math.round((updates.estimated_margin / basePrice) * 1000) / 10 : 0
  }

  const result = await db.collection('reference_designs').findOneAndUpdate(
    { id: req.params.id },
    { $set: updates },
    { returnDocument: 'after' },
  )
  if (!result) return err('Reference not found', 404)
  const { _id, ...clean } = result
  return ok(clean)
}))

// POST /admin/references/:id/approve — publish
router.post('/admin/references/:id/approve', asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const result = await db.collection('reference_designs').findOneAndUpdate(
    { id: req.params.id },
    { $set: {
      status:   'approved',
      active:   true,
      approved_by: req.adminId,
      approved_at: new Date(),
      updated_at:  new Date(),
    }},
    { returnDocument: 'after' },
  )
  if (!result) return err('Reference not found', 404)
  const { _id, ...clean } = result
  return ok(clean)
}))

// POST /admin/references/:id/reject
router.post('/admin/references/:id/reject', asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const reason = String(req.body.reason || '').slice(0, 500)
  const result = await db.collection('reference_designs').findOneAndUpdate(
    { id: req.params.id },
    { $set: {
      status: 'rejected',
      active: false,
      rejection_reason: reason || 'Rejected by admin',
      updated_at: new Date(),
    }},
    { returnDocument: 'after' },
  )
  if (!result) return err('Reference not found', 404)
  const { _id, ...clean } = result
  return ok(clean)
}))

// POST /admin/references/:id/deactivate — pause without rejecting
router.post('/admin/references/:id/deactivate', asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const result = await db.collection('reference_designs').findOneAndUpdate(
    { id: req.params.id },
    { $set: { active: false, updated_at: new Date() } },
    { returnDocument: 'after' },
  )
  if (!result) return err('Reference not found', 404)
  const { _id, ...clean } = result
  return ok(clean)
}))

// POST /admin/references/:id/activate — re-enable
router.post('/admin/references/:id/activate', asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const result = await db.collection('reference_designs').findOneAndUpdate(
    { id: req.params.id, status: 'approved' },
    { $set: { active: true, updated_at: new Date() } },
    { returnDocument: 'after' },
  )
  if (!result) return err('Reference not found or not approved', 404)
  const { _id, ...clean } = result
  return ok(clean)
}))

// DELETE /admin/references/:id
router.delete('/admin/references/:id', asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const result = await db.collection('reference_designs').findOneAndDelete({ id: req.params.id })
  if (!result) return err('Reference not found', 404)
  return ok({ deleted: true, id: req.params.id })
}))

// GET /admin/references/sku-search — lightweight SKU search for the "Add Item" picker
router.get('/admin/references/sku-search', asyncRoute(async (req, res, ok) => {
  const db = await connectToMongo()
  const { q = '', category, color, finish, limit = 30 } = req.query

  const filter = { active: true }
  if (category) filter.category = category
  if (color)    filter.color = { $regex: `^${color}$`, $options: 'i' }
  if (finish)   filter.finish = { $regex: finish, $options: 'i' }
  if (q) {
    filter.$or = [
      { sku_code:         { $regex: q, $options: 'i' } },
      { subcategory:      { $regex: q, $options: 'i' } },
      { color:            { $regex: q, $options: 'i' } },
      { image_search_ref: { $regex: q, $options: 'i' } },
    ]
  }

  const items = await db.collection('master_inventory')
    .find(filter)
    .limit(Math.min(100, Number(limit) || 30))
    .toArray()

  return ok({
    items: items.map(({ _id, ...i }) => ({
      sku_code: i.sku_code,
      id: i.id,
      name: [i.color, i.finish, i.subcategory, i.size_inches ? `${i.size_inches}"` : ''].filter(Boolean).join(' '),
      category: i.category,
      subcategory: i.subcategory,
      color: i.color,
      finish: i.finish,
      size_inches: i.size_inches,
      per_unit_cost: i.per_unit_cost,
      selling_price_per_unit: i.selling_price_per_unit,
    })),
  })
}))

// GET /admin/references/stats — summary for dashboard
router.get('/admin/references-stats', asyncRoute(async (req, res, ok) => {
  const db = await connectToMongo()
  const col = db.collection('reference_designs')

  const [total, active, pending, byOccasion, avgMargin] = await Promise.all([
    col.countDocuments({}),
    col.countDocuments({ active: true }),
    col.countDocuments({ status: 'pending_review' }),
    col.aggregate([
      { $match: { active: true } },
      { $group: { _id: '$occasion', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]).toArray(),
    col.aggregate([
      { $match: { active: true } },
      { $group: { _id: null, avg: { $avg: '$margin_percent' } } },
    ]).toArray(),
  ])

  return ok({
    total,
    active,
    pending_review: pending,
    by_occasion: byOccasion.map(o => ({ name: o._id, count: o.count })),
    avg_margin_percent: avgMargin[0]?.avg || 0,
  })
}))

export default router
