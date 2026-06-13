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

/**
 * Sync the master_inventory usage tracking for a reference:
 *   - Remove this referenceId from any SKU that no longer uses it
 *   - Add this referenceId to every SKU now used (idempotent, no duplicates)
 *
 * Called after a reference's detected_items are saved/updated, and when the
 * reference is deleted (pass empty newSkuCodes).
 */
async function syncSkuUsage(db, referenceId, newSkuCodes) {
  const cleanCodes = [...new Set((newSkuCodes || []).filter(Boolean))]

  // 1. Remove referenceId from any SKU that's no longer in the list
  await db.collection('master_inventory').updateMany(
    {
      used_in_references: referenceId,
      ...(cleanCodes.length > 0 ? { sku_code: { $nin: cleanCodes } } : {}),
    },
    {
      $pull: { used_in_references: referenceId },
      $set:  { last_referenced_at: new Date() },
    },
  )

  // 2. Add referenceId to all SKUs now in the list (skip if already there)
  if (cleanCodes.length > 0) {
    await db.collection('master_inventory').updateMany(
      { sku_code: { $in: cleanCodes } },
      {
        $addToSet: { used_in_references: referenceId },
        $set: {
          ai_used: true,
          last_referenced_at: new Date(),
        },
      },
    )
  }
}

// Look up the best SKU candidates for a detected item, then ask Gemini to pick the best match.
// Specific shapes (bottle / number / letter / heart / star) MUST match a SKU with that
// shape — otherwise we auto-create. This prevents a "champagne bottle" detection from
// silently being routed to a "gold number 5" SKU just because both are foil balloons.
async function findBestSkuMatch(db, detection) {
  const filter = { active: true }
  const type  = String(detection.type  || '').toLowerCase()
  const shape = String(detection.shape || '').toLowerCase()

  if (type === 'latex_balloon') filter.category = 'Latex Balloons'
  else if (type === 'foil_balloon') filter.category = 'Foil Balloons'
  else if (type === 'backdrop') filter.category = { $regex: 'backdrop', $options: 'i' }
  else if (type === 'light')    filter.category = { $regex: 'light',    $options: 'i' }
  else if (type === 'flower')   filter.category = { $regex: 'flower',   $options: 'i' }
  else if (type === 'prop')     filter.category = { $regex: 'prop',     $options: 'i' }

  if (detection.color)  filter.color  = { $regex: `^${detection.color}$`, $options: 'i' }
  if (detection.finish) filter.finish = { $regex: detection.finish, $options: 'i' }
  if (detection.size_inches) {
    const s = Number(detection.size_inches)
    filter.size_inches = { $gte: s - 2, $lte: s + 2 }
  }

  // Specific-shape detections must match shape — these aren't substitutable with
  // any other foil balloon. If no shape match exists, auto-create.
  const SPECIFIC_SHAPES = ['bottle', 'number', 'letter']
  const SOFT_SHAPES     = ['heart', 'star']
  const isSpecific      = SPECIFIC_SHAPES.includes(shape)
  const isSoftShape     = SOFT_SHAPES.includes(shape)

  if (isSpecific || isSoftShape) {
    filter.$or = [
      { shape:       { $regex: shape, $options: 'i' } },
      { subcategory: { $regex: shape, $options: 'i' } },
      { sku_code:    { $regex: shape, $options: 'i' } },
    ]
  }

  let candidates = await db.collection('master_inventory').find(filter).limit(20).toArray()

  // Widen if no candidates: size first, then finish, then color.
  // For specific shapes (bottle/number/letter), never widen colour — better to
  // auto-create than match the wrong item.
  if (candidates.length === 0) {
    delete filter.size_inches
    candidates = await db.collection('master_inventory').find(filter).limit(20).toArray()
  }
  if (candidates.length === 0) {
    delete filter.finish
    candidates = await db.collection('master_inventory').find(filter).limit(20).toArray()
  }
  if (candidates.length === 0 && !isSpecific) {
    delete filter.color
    candidates = await db.collection('master_inventory').find(filter).limit(20).toArray()
  }

  if (candidates.length === 0) {
    // No inventory match — auto-create a placeholder SKU
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

  // Gemini service unavailable or threw — fall back to the best candidate
  // we already found in inventory. Auto-create is a last resort; for common
  // balloons we'd rather match an existing SKU at "low" confidence than mint
  // a new one for every Gemini hiccup.
  if (!match.success || !match.matched_sku_code) {
    const fallback = candidates[0]
    return {
      sku: fallback,
      confidence: 'low',
      reasoning: 'Gemini matcher unavailable — picked best candidate by filter',
    }
  }

  // Gemini returned a SKU code that's not in our candidates list — likely a
  // hallucination. Auto-create rather than blindly insert the wrong SKU.
  const matchedSku = candidates.find(c => c.sku_code === match.matched_sku_code)
  if (!matchedSku) {
    if (isSpecific) {
      const created = await autoCreateSku(db, detection)
      return {
        sku: created,
        confidence: 'auto_created',
        reasoning: 'Gemini returned an invalid SKU code on specific shape — auto-created',
      }
    }
    // For non-specific shapes, prefer first candidate over auto-create
    return {
      sku: candidates[0],
      confidence: 'low',
      reasoning: 'Gemini returned unknown SKU — picked first candidate',
    }
  }

  // Specific shape (bottle / number / letter) + low confidence → auto-create.
  // For soft shapes and common shapes, accept the low-confidence match.
  if (match.confidence === 'low' && isSpecific) {
    const created = await autoCreateSku(db, detection)
    return {
      sku: created,
      confidence: 'auto_created',
      reasoning: `Low-confidence match for specific shape (${shape}) — auto-created instead`,
    }
  }

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
          raw_detection:    `${qty}x ${det.color || ''} ${det.finish || ''} ${det.type || ''}${det.size_inches ? ` ${det.size_inches}"` : ''}`.replace(/\s+/g, ' ').trim(),
          matched_sku_code: match.sku.sku_code,
          matched_sku_id:   match.sku.id,
          // Customer-visible name: no underscores, no meaningless 0" size suffix
          sku_name:         [match.sku.color, String(match.sku.subcategory || '').replace(/_/g, ' '), match.sku.size_inches ? `${match.sku.size_inches}"` : ''].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim(),
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

    // 6. Update inventory usage tracking so admin can filter "Used in references"
    const usedSkuCodes = detectedItems.map(i => i.matched_sku_code).filter(Boolean)
    await syncSkuUsage(db, referenceId, usedSkuCodes)
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

  // Use provided overrides if admin set them in the form.
  // Multi-value fields (occasions, setup_types) accept either an array or a
  // comma-separated string; we normalise to arrays.
  const toArray = (v) => {
    if (Array.isArray(v)) return v.map(x => String(x || '').trim().toLowerCase()).filter(Boolean)
    if (typeof v === 'string') return v.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    return []
  }

  const basePrice = Number(req.body.base_price) || parsed.price || 0
  const occasions   = (() => {
    const fromBody = toArray(req.body.occasions || req.body.occasion)
    return fromBody.length > 0 ? fromBody : (parsed.occasions || []).map(o => o.toLowerCase())
  })()
  const setupTypes  = (() => {
    const fromBody = toArray(req.body.setup_types || req.body.setup_type)
    return fromBody.length > 0 ? fromBody : (parsed.setup_types || []).map(s => s.toLowerCase())
  })()
  const occasion  = occasions[0]  || ''
  const setupType = setupTypes[0] || ''
  const theme     = String(req.body.theme || parsed.theme || '')

  if (!basePrice) return err('Could not determine base price from filename. Pass base_price in form data.', 400)

  const referenceId = uuidv4()
  // Bracket reflects what the CUSTOMER pays end-to-end (with setup/fees/GST),
  // NOT just the decoration value. A Rs 7,500 decoration is Rs 9,736 total →
  // still falls in 5K-10K. A Rs 10K decoration is Rs ~12,800 → 10K-15K. This
  // matches what the customer picks in their budget selector.
  const breakdownForBracket = customerBreakdown(basePrice)
  const bracket = bracketForPrice(breakdownForBracket.total)

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
    occasion,                       // primary (legacy)
    occasions,                      // all detected occasions
    theme,
    setup_type:    setupType,       // primary (legacy)
    setup_types:   setupTypes,      // all detected setup types
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
  const { occasion, setup_type, status, theme, bracket, page = 1, limit = 30, sort = 'recent' } = req.query

  // Idempotently re-tag any reference whose bracket is stale (e.g. uploaded
  // before the customer-total bracket rule). Keeps the filter result correct
  // even when this endpoint is called before /budget-coverage.
  await autoRebuildBrackets(db)

  const filter = {}
  // Occasion filter matches either the legacy single-value field OR any element
  // in the new occasions[] array.
  if (occasion) filter.$or = [{ occasion }, { occasions: occasion }]
  if (setup_type) {
    const setupOr = [{ setup_type }, { setup_types: setup_type }]
    filter.$or = filter.$or ? [...filter.$or, ...setupOr] : setupOr
  }
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

// POST /admin/references/backfill-sku-usage — rebuild master_inventory.used_in_references
// from scratch for all references. Safe to re-run.
router.post('/admin/references/backfill-sku-usage', asyncRoute(async (req, res, ok) => {
  const db = await connectToMongo()

  // 1. Wipe used_in_references everywhere
  await db.collection('master_inventory').updateMany(
    {},
    { $set: { used_in_references: [], ai_used: false } },
  )

  // 2. Walk every reference and rebuild
  const refs = await db.collection('reference_designs')
    .find({})
    .project({ id: 1, detected_items: 1 })
    .toArray()

  let touched = 0
  for (const r of refs) {
    const codes = (r.detected_items || []).map(i => i.matched_sku_code).filter(Boolean)
    if (codes.length === 0) continue
    await syncSkuUsage(db, r.id, codes)
    touched++
  }

  return ok({ references_processed: touched, total_references: refs.length })
}))

// Helper: bracket should reflect what CUSTOMER pays (with setup + fees + GST),
// not the bare decoration price. Keeps bracket label in sync with checkout.
function classifyBracket(basePrice) {
  const breakdown = customerBreakdown(basePrice)
  return bracketForPrice(breakdown.total)
}

// Walks every reference and re-tags any whose budget_bracket no longer matches
// the current classifyBracket() rule. Idempotent — safe to call frequently.
// Returns { scanned, migrated }.
async function autoRebuildBrackets(db) {
  const all = await db.collection('reference_designs')
    .find({})
    .project({ id: 1, base_price: 1, budget_bracket: 1 })
    .toArray()
  let migrated = 0
  for (const r of all) {
    const b = classifyBracket(r.base_price)
    if (r.budget_bracket !== b.id) {
      await db.collection('reference_designs').updateOne(
        { id: r.id },
        { $set: { budget_bracket: b.id, budget_bracket_label: b.label } },
      )
      migrated++
    }
  }
  return { scanned: all.length, migrated }
}

// POST /admin/references/backfill-brackets — recompute bracket for every reference
// using the current rule (customer total). Safe to re-run; pass ?force=true to
// re-tag even references that already have a bracket set.
router.post('/admin/references/backfill-brackets', asyncRoute(async (req, res, ok) => {
  const db = await connectToMongo()
  const force = req.query.force === 'true' || req.body?.force === true

  const filter = force
    ? {}
    : { $or: [{ budget_bracket: { $exists: false } }, { budget_bracket: null }] }

  const refs = await db.collection('reference_designs').find(filter).toArray()

  let updated = 0, changed = 0
  for (const r of refs) {
    const b = classifyBracket(r.base_price)
    if (r.budget_bracket !== b.id) changed++
    await db.collection('reference_designs').updateOne(
      { id: r.id },
      { $set: { budget_bracket: b.id, budget_bracket_label: b.label } },
    )
    updated++
  }
  return ok({ updated, changed, force })
}))

// GET /admin/references/budget-coverage — bracket × occasion matrix + gap detector.
// Auto-backfills any references missing budget_bracket as a side effect so the matrix
// is always correct without admin having to hit the migration endpoint manually.
router.get('/admin/references/budget-coverage', asyncRoute(async (req, res, ok) => {
  const db = await connectToMongo()

  // Auto-rebuild brackets so the matrix is always correct
  await autoRebuildBrackets(db)

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
    const b = classifyBracket(r.base_price)
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

  // Normalize multi-value fields if admin edited them
  const toCsvArray = (v) => {
    if (Array.isArray(v)) return v.map(x => String(x || '').trim().toLowerCase()).filter(Boolean)
    if (typeof v === 'string') return v.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    return null
  }
  if ('occasions' in updates) {
    const arr = toCsvArray(updates.occasions) || []
    updates.occasions = arr
    updates.occasion  = arr[0] || ''   // keep legacy field in sync
  } else if ('occasion' in updates) {
    const arr = toCsvArray(updates.occasion) || []
    if (arr.length > 1) {
      updates.occasions = arr
      updates.occasion  = arr[0]
    }
  }
  if ('setup_types' in updates) {
    const arr = toCsvArray(updates.setup_types) || []
    updates.setup_types = arr
    updates.setup_type  = arr[0] || ''
  } else if ('setup_type' in updates) {
    const arr = toCsvArray(updates.setup_type) || []
    if (arr.length > 1) {
      updates.setup_types = arr
      updates.setup_type  = arr[0]
    }
  }

  // If base_price changed, re-classify bracket based on the CUSTOMER total
  // (not the bare decoration price). Keeps bracket label in sync with what
  // customer actually sees and pays at checkout.
  if (updates.base_price !== undefined) {
    const breakdownForBracket = customerBreakdown(updates.base_price)
    const b = bracketForPrice(breakdownForBracket.total)
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

  // Sync inventory usage tracking if items changed
  if (itemsChanged) {
    const usedSkuCodes = (result.detected_items || []).map(i => i.matched_sku_code).filter(Boolean)
    await syncSkuUsage(db, req.params.id, usedSkuCodes)
  }

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
  // Remove this reference from all SKUs that tracked it
  await syncSkuUsage(db, req.params.id, [])
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
