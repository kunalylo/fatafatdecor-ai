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
import { BUDGET_BRACKETS, bracketForPrice } from '../lib/budget-brackets.js'
import { customerBreakdown, adminMargin } from '../lib/pricing-calc.js'
import { estimateUnitCost, buildAutoSkuCode } from '../lib/sku-defaults.js'

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

/**
 * Create a placeholder master_inventory SKU for a detected item with no inventory match.
 * Cost is estimated from category + size. Admin can refine later.
 */
async function autoCreateSku(db, detection) {
  const cost = estimateUnitCost(detection)
  const sell = Math.round(cost * 2 * 100) / 100
  const sku_code = buildAutoSkuCode(detection)

  // Try to upsert — if another reference already triggered the same SKU, reuse it
  const existing = await db.collection('master_inventory').findOne({ sku_code })
  if (existing) return existing

  const doc = {
    id: uuidv4(),
    sku_code,
    category:
      detection.type === 'latex_balloon' ? 'Latex Balloons' :
      detection.type === 'foil_balloon'  ? 'Foil Balloons'  :
      detection.type === 'backdrop'      ? 'Foil Balloon Backdrop Units' :
      detection.type === 'light'         ? 'Lights' :
      detection.type === 'flower'        ? 'Flowers' :
      detection.type === 'prop'          ? 'Props'  :
      'Other',
    subcategory: String(detection.subtype || detection.shape || detection.type || 'Auto'),
    brand_supplier: 'AUTO-CREATED — review and assign supplier',
    material: detection.type === 'foil_balloon' ? 'Foil/Mylar' : 'Latex/Other',
    finish: String(detection.finish || ''),
    shape: String(detection.shape || ''),
    size_inches: Number(detection.size_inches) || 0,
    color: String(detection.color || ''),
    pack_quantity: 1,
    cost_price_pack: cost,
    per_unit_cost: cost,
    selling_price_pack: sell,
    selling_price_per_unit: sell,
    source_url: '',
    image_search_ref: `${detection.color || ''} ${detection.finish || ''} ${detection.type || ''} ${detection.size_inches || ''}`.trim(),
    ai_usage_notes: 'Auto-created from reference design upload — review cost and supplier',
    inventory_status: 'Active',
    active: true,
    auto_created: true,
    needs_review: true,
    stock_count: 0,
    reorder_threshold: 50,
    created_at: new Date(),
    updated_at: new Date(),
  }
  try {
    await db.collection('master_inventory').insertOne(doc)
  } catch (e) {
    // Race condition — another concurrent upload created the same SKU
    return await db.collection('master_inventory').findOne({ sku_code })
  }
  return doc
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
  if (candidates.length === 0) {
    // No inventory match even after widening — auto-create a placeholder SKU
    const created = await autoCreateSku(db, detection)
    return {
      sku: created,
      confidence: 'auto_created',
      reasoning: `No matching SKU found — auto-created ${created.sku_code} with estimated cost Rs ${created.per_unit_cost}`,
    }
  }

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

    // 3. Pricing: new model — base_price is the decoration & material total at 2x.
    //    Customer pays base_price + setup_transport + platform + convenience + GST 18%.
    const basePrice = Number(ref.base_price) || 0
    const breakdown = customerBreakdown(basePrice)
    const margin    = adminMargin(basePrice, itemsCostTotal)
    const itemsGap  = Math.max(0, basePrice - itemsPriceTotal)  // how short of base_price are the items at 2x

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
    await db.collection('reference_designs').updateOne(
      { id: referenceId },
      { $set: {
        status: 'pending_review',
        detected_items:      detectedItems,
        items_cost_total:    Math.round(itemsCostTotal * 100) / 100,
        items_price_total:   Math.round(itemsPriceTotal * 100) / 100,
        items_gap:           Math.round(itemsGap * 100) / 100,   // base_price - items_price_total
        customer_breakdown:  breakdown,                          // setup/platform/conv/gst/total
        estimated_margin:    margin.operating_margin,
        margin_percent:      margin.margin_percent,
        // Legacy field kept for backward compat (some old code may still read it)
        service_charge:      breakdown.fees_subtotal,
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
  const bracket = bracketForPrice(basePrice)

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
    budget_bracket: bracket.id,
    budget_bracket_label: bracket.label,
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
  const { occasion, status, theme, bracket, page = 1, limit = 30, sort = 'recent' } = req.query

  const filter = {}
  if (occasion) filter.occasion = occasion
  if (status)   filter.status   = status
  if (theme)    filter.theme    = { $regex: theme, $options: 'i' }
  if (bracket)  filter.budget_bracket = bracket

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

// ── STATIC-PATH ROUTES MUST BE BEFORE /:id ──────────────────────
// (Express matches in order — /:id swallows literal paths otherwise.)

// POST /admin/references/backfill-brackets — one-shot to tag pre-bracket references
router.post('/admin/references/backfill-brackets', asyncRoute(async (req, res, ok) => {
  const db = await connectToMongo()
  const refs = await db.collection('reference_designs')
    .find({ $or: [{ budget_bracket: { $exists: false } }, { budget_bracket: null }] })
    .toArray()

  let updated = 0
  for (const r of refs) {
    const b = bracketForPrice(r.base_price)
    await db.collection('reference_designs').updateOne(
      { id: r.id },
      { $set: { budget_bracket: b.id, budget_bracket_label: b.label } },
    )
    updated++
  }
  return ok({ updated })
}))

// GET /admin/references/budget-coverage — bracket × occasion matrix + gap detector.
// Auto-backfills any references missing budget_bracket as a side effect so the matrix
// is always correct without admin having to hit the migration endpoint manually.
router.get('/admin/references/budget-coverage', asyncRoute(async (req, res, ok) => {
  const db = await connectToMongo()

  // Auto-backfill any references missing budget_bracket
  const missing = await db.collection('reference_designs')
    .find({ $or: [{ budget_bracket: { $exists: false } }, { budget_bracket: null }] })
    .toArray()
  for (const r of missing) {
    const b = bracketForPrice(r.base_price)
    await db.collection('reference_designs').updateOne(
      { id: r.id },
      { $set: { budget_bracket: b.id, budget_bracket_label: b.label } },
    )
  }

  const refs = await db.collection('reference_designs')
    .find({ active: true })
    .project({ base_price: 1, occasion: 1, margin_percent: 1, budget_bracket: 1 })
    .toArray()

  // Build coverage matrix: bracket × occasion → count
  const occasions = [
    'birthday','anniversary','wedding','baby_shower','engagement',
    'corporate','festival','housewarming','new_year','store_opening',
    'party','dinner',
  ]

  const matrix = {}            // matrix[bracketId][occasion] = count
  const bracketTotals = {}     // bracketTotals[bracketId] = { count, margin_sum }
  const occasionTotals = {}    // occasionTotals[occasion]  = count

  for (const b of BUDGET_BRACKETS) {
    matrix[b.id] = {}
    for (const o of occasions) matrix[b.id][o] = 0
    bracketTotals[b.id] = { count: 0, margin_sum: 0 }
  }
  for (const o of occasions) occasionTotals[o] = 0

  for (const r of refs) {
    const b = bracketForPrice(r.base_price)
    const occ = (r.occasion || '').toLowerCase()
    if (matrix[b.id] && occasions.includes(occ)) {
      matrix[b.id][occ]            += 1
      occasionTotals[occ]          += 1
    }
    bracketTotals[b.id].count      += 1
    bracketTotals[b.id].margin_sum += Number(r.margin_percent) || 0
  }

  const brackets = BUDGET_BRACKETS.map(b => {
    const t = bracketTotals[b.id]
    return {
      ...b,
      count: t.count,
      avg_margin: t.count > 0 ? Math.round((t.margin_sum / t.count) * 10) / 10 : 0,
      by_occasion: matrix[b.id],
    }
  })

  // Identify gaps: bracket + occasion pairs with zero references
  const gaps = []
  for (const b of BUDGET_BRACKETS) {
    for (const o of occasions) {
      if (matrix[b.id][o] === 0 && occasionTotals[o] > 0) {
        gaps.push({ bracket: b.id, bracket_label: b.label, occasion: o })
      }
    }
  }

  return ok({
    total_references: refs.length,
    backfilled: missing.length,
    brackets,
    occasions,
    occasion_totals: occasionTotals,
    gaps,
  })
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

  // If base_price changed, re-classify bracket
  if (updates.base_price !== undefined) {
    const b = bracketForPrice(updates.base_price)
    updates.budget_bracket       = b.id
    updates.budget_bracket_label = b.label
  }

  // Recompute pricing if items or base_price changed
  const itemsChanged = Array.isArray(updates.detected_items)
  const priceChanged = updates.base_price !== undefined
  if (itemsChanged || priceChanged) {
    const ref = await db.collection('reference_designs').findOne({ id: req.params.id })

    let cost  = ref?.items_cost_total  || 0
    let price = ref?.items_price_total || 0
    if (itemsChanged) {
      cost  = 0; price = 0
      for (const i of updates.detected_items) {
        cost  += (Number(i.unit_cost)  || 0) * (Number(i.quantity) || 1)
        price += (Number(i.unit_price) || 0) * (Number(i.quantity) || 1)
      }
      updates.items_cost_total  = Math.round(cost  * 100) / 100
      updates.items_price_total = Math.round(price * 100) / 100
    }

    const basePrice = Number(updates.base_price ?? ref?.base_price ?? 0)
    const breakdown = customerBreakdown(basePrice)
    const margin    = adminMargin(basePrice, cost)

    updates.items_gap          = Math.max(0, Math.round((basePrice - price) * 100) / 100)
    updates.customer_breakdown = breakdown
    updates.service_charge     = breakdown.fees_subtotal  // legacy
    updates.estimated_margin   = margin.operating_margin
    updates.margin_percent     = margin.margin_percent
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
