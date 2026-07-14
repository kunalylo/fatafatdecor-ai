// /admin/inventory/* — Master inventory (Excel-driven) CRUD for admin app.
// Powers the "All Items" tab in the new Inventory section.

import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import multer from 'multer'
import XLSX from 'xlsx'
import { connectToMongo } from '../db.js'
import { requireAdmin } from '../jwt.js'
import { asyncRoute } from '../helpers.js'
import { generateAndAttachItemImage, uploadItemImageToImageKit } from '../lib/item-image.js'

const router = Router()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } })

router.use('/admin/inventory', requireAdmin)

// ── GET /admin/inventory/items — paginated list with filters ────
router.get('/admin/inventory/items', asyncRoute(async (req, res, ok) => {
  const db = await connectToMongo()
  const {
    category, subcategory, color, finish, size, search,
    page = 1, limit = 50, active, auto_only, used_only,
  } = req.query

  const filter = {}
  if (category)    filter.category    = category
  if (subcategory) filter.subcategory = subcategory
  if (color)       filter.color       = color
  if (finish)      filter.finish      = finish
  if (size)        filter.size_inches = Number(size)
  if (active !== undefined) filter.active = active === 'true'
  if (auto_only === 'true') filter.auto_created = true
  if (used_only === 'true') filter.used_in_references = { $exists: true, $not: { $size: 0 } }
  if (search) {
    filter.$or = [
      { sku_code:        { $regex: search, $options: 'i' } },
      { image_search_ref:{ $regex: search, $options: 'i' } },
      { color:           { $regex: search, $options: 'i' } },
      { category:        { $regex: search, $options: 'i' } },
    ]
  }

  const pageNum  = Math.max(1, Number(page))
  const limitNum = Math.min(200, Math.max(1, Number(limit)))
  const skip     = (pageNum - 1) * limitNum

  const [items, total] = await Promise.all([
    db.collection('master_inventory').find(filter).skip(skip).limit(limitNum).toArray(),
    db.collection('master_inventory').countDocuments(filter),
  ])

  return ok({
    items: items.map(({ _id, ...i }) => ({
      ...i,
      used_in_references_count: Array.isArray(i.used_in_references) ? i.used_in_references.length : 0,
    })),
    total,
    page: pageNum,
    limit: limitNum,
    pages: Math.ceil(total / limitNum),
  })
}))

// ── GET /admin/inventory/stats — category breakdown for filter UI ────
router.get('/admin/inventory/stats', asyncRoute(async (req, res, ok) => {
  const db = await connectToMongo()
  const col = db.collection('master_inventory')

  // Auto-backfill usage tracking once if it appears empty
  // (one-shot — safe to call repeatedly)
  const hasAnyUsageTracking = await col.countDocuments({ ai_used: true }, { limit: 1 })
  if (hasAnyUsageTracking === 0) {
    const refs = await db.collection('reference_designs')
      .find({})
      .project({ id: 1, detected_items: 1 })
      .toArray()
    for (const r of refs) {
      const codes = [...new Set((r.detected_items || []).map(i => i.matched_sku_code).filter(Boolean))]
      if (codes.length > 0) {
        await col.updateMany(
          { sku_code: { $in: codes } },
          { $addToSet: { used_in_references: r.id }, $set: { ai_used: true, last_referenced_at: new Date() } },
        )
      }
    }
  }

  const [total, autoCreated, usedCount, withImages, byCategory, byColor, byFinish] = await Promise.all([
    col.countDocuments({ active: true }),
    col.countDocuments({ active: true, auto_created: true }),
    col.countDocuments({ active: true, used_in_references: { $exists: true, $not: { $size: 0 } } }),
    col.countDocuments({ active: true, image_url: { $exists: true, $nin: [null, ''] } }),
    col.aggregate([
      { $match: { active: true } },
      { $group: { _id: '$category', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]).toArray(),
    col.aggregate([
      { $match: { active: true } },
      { $group: { _id: '$color', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 50 },
    ]).toArray(),
    col.aggregate([
      { $match: { active: true } },
      { $group: { _id: '$finish', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]).toArray(),
  ])

  return ok({
    total,
    auto_created: autoCreated,
    used_in_references: usedCount,
    with_images: withImages,
    missing_images: Math.max(0, total - withImages),
    categories: byCategory.map(c => ({ name: c._id, count: c.count })),
    colors:     byColor.map(c => ({ name: c._id, count: c.count })),
    finishes:   byFinish.map(c => ({ name: c._id, count: c.count })),
  })
}))

// ── GET /admin/inventory/items/:id ────
router.get('/admin/inventory/items/:id', asyncRoute(async (req, res, ok, err) => {
  const db   = await connectToMongo()
  const item = await db.collection('master_inventory').findOne({
    $or: [{ id: req.params.id }, { sku_code: req.params.id }],
  })
  if (!item) return err('Item not found', 404)

  // Find references using this SKU
  const usedIn = await db.collection('reference_designs').find({
    'detected_items.matched_sku_code': item.sku_code,
    active: true,
  }).project({ id: 1, base_price: 1, occasion: 1, image_url: 1, thumbnail_url: 1 }).limit(20).toArray()

  const { _id, ...clean } = item
  return ok({ ...clean, used_in_references: usedIn.map(({ _id, ...r }) => r) })
}))

// ── POST /admin/inventory/items — manual add ────
router.post('/admin/inventory/items', asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const b  = req.body
  if (!b.sku_code) return err('sku_code required')

  const existing = await db.collection('master_inventory').findOne({ sku_code: b.sku_code })
  if (existing) return err('SKU code already exists', 409)

  const cost = Number(b.per_unit_cost) || 0
  const sell = b.selling_price_per_unit ? Number(b.selling_price_per_unit) : cost * 2

  const doc = {
    id: uuidv4(),
    sku_code:        String(b.sku_code).trim(),
    category:        String(b.category || '').trim(),
    subcategory:     String(b.subcategory || '').trim(),
    brand_supplier:  String(b.brand_supplier || '').trim(),
    material:        String(b.material || '').trim(),
    finish:          String(b.finish || '').trim(),
    shape:           String(b.shape || '').trim(),
    size_inches:     Number(b.size_inches) || 0,
    color:           String(b.color || '').trim(),
    pack_quantity:   Number(b.pack_quantity) || 0,
    cost_price_pack: Number(b.cost_price_pack) || 0,
    per_unit_cost:   cost,
    selling_price_pack:     Number(b.selling_price_pack) || cost * 2 * (Number(b.pack_quantity) || 1),
    selling_price_per_unit: sell,
    inventory_status:       String(b.inventory_status || 'Active'),
    budget_fit:             String(b.budget_fit || ''),
    source_url:             String(b.source_url || ''),
    image_url:              String(b.image_url || ''),
    image_search_ref:       String(b.image_search_ref || ''),
    ai_usage_notes:         String(b.ai_usage_notes || ''),
    stock_count:            Number(b.stock_count) || 0,
    reorder_threshold:      Number(b.reorder_threshold) || 50,
    active: b.active !== false,
    created_at: new Date(),
    updated_at: new Date(),
  }
  await db.collection('master_inventory').insertOne(doc)

  // Every item gets an image: if admin didn't supply one, AI-generate a clean
  // product shot in the background (fire-and-forget — never blocks the save).
  if (!doc.image_url) {
    generateAndAttachItemImage(db, doc)
      .catch(e => console.warn(`[inventory] auto image for ${doc.sku_code} failed:`, e.message))
  }

  const { _id, ...clean } = doc
  return ok(clean)
}))

// ── POST /admin/inventory/items/:id/image — admin uploads a real photo ────
router.post('/admin/inventory/items/:id/image', asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const { image_base64 } = req.body
  if (!image_base64 || !String(image_base64).includes('base64')) {
    return err('image_base64 (data URL) required')
  }
  const item = await db.collection('master_inventory').findOne(
    { $or: [{ id: req.params.id }, { sku_code: req.params.id }] },
  )
  if (!item) return err('Item not found', 404)

  const buffer = Buffer.from(String(image_base64).split(',', 2)[1], 'base64')
  if (buffer.length > 8 * 1024 * 1024) return err('Image too large (max 8MB)')
  const safe = String(item.sku_code || item.id).replace(/[^A-Za-z0-9_-]+/g, '_')
  const ik = await uploadItemImageToImageKit(buffer, `item_${safe}.jpg`)

  await db.collection('master_inventory').updateOne(
    { id: item.id },
    { $set: { image_url: ik.image_url, image_file_id: ik.file_id, image_auto_generated: false, updated_at: new Date() } },
  )
  return ok({ image_url: ik.image_url })
}))

// ── POST /admin/inventory/items/:id/generate-image — AI product shot ────
router.post('/admin/inventory/items/:id/generate-image', asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const item = await db.collection('master_inventory').findOne(
    { $or: [{ id: req.params.id }, { sku_code: req.params.id }] },
  )
  if (!item) return err('Item not found', 404)
  try {
    const url = await generateAndAttachItemImage(db, item)
    return ok({ image_url: url })
  } catch (e) {
    return err('Image generation failed: ' + e.message, 500)
  }
}))

// ── POST /admin/inventory/generate-missing-images — bulk fill ────
// Processes a small batch per call ({limit}); the admin UI loops until
// remaining = 0. Items used in references are filled first.
router.post('/admin/inventory/generate-missing-images', asyncRoute(async (req, res, ok) => {
  const db = await connectToMongo()
  const limit = Math.min(25, Math.max(1, Number(req.body?.limit) || 10))
  const missingFilter = {
    active: true,
    $or: [{ image_url: { $exists: false } }, { image_url: null }, { image_url: '' }],
  }

  const batch = await db.collection('master_inventory')
    .find(missingFilter)
    .sort({ ai_used: -1, last_referenced_at: -1 })
    .limit(limit)
    .toArray()

  let generated = 0
  const failed = []
  // Concurrency 3 — quick without hammering fal/ImageKit
  for (let i = 0; i < batch.length; i += 3) {
    const results = await Promise.allSettled(
      batch.slice(i, i + 3).map(item => generateAndAttachItemImage(db, item)),
    )
    results.forEach((r, j) => {
      if (r.status === 'fulfilled') generated++
      else failed.push({ sku: batch[i + j].sku_code, error: r.reason?.message })
    })
  }
  if (failed.length) console.warn('[inventory] bulk image failures:', JSON.stringify(failed.slice(0, 5)))

  const remaining = await db.collection('master_inventory').countDocuments(missingFilter)
  return ok({ generated, failed: failed.length, remaining })
}))

// ── PUT /admin/inventory/items/:id — update fields ────
router.put('/admin/inventory/items/:id', asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const b  = req.body

  // If cost changed and selling not explicitly set → auto-apply 2x rule
  const updates = { ...b, updated_at: new Date() }
  if (b.per_unit_cost !== undefined && b.selling_price_per_unit === undefined) {
    updates.selling_price_per_unit = Number(b.per_unit_cost) * 2
  }
  delete updates._id
  delete updates.id

  const result = await db.collection('master_inventory').findOneAndUpdate(
    { $or: [{ id: req.params.id }, { sku_code: req.params.id }] },
    { $set: updates },
    { returnDocument: 'after' },
  )
  if (!result) return err('Item not found', 404)
  const { _id, ...clean } = result
  return ok(clean)
}))

// ── DELETE /admin/inventory/items/:id — soft delete ────
router.delete('/admin/inventory/items/:id', asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const result = await db.collection('master_inventory').findOneAndUpdate(
    { $or: [{ id: req.params.id }, { sku_code: req.params.id }] },
    { $set: { active: false, updated_at: new Date() } },
    { returnDocument: 'after' },
  )
  if (!result) return err('Item not found', 404)
  return ok({ deleted: true, sku_code: result.sku_code })
}))

// ── POST /admin/inventory/import-excel — bulk import from .xlsx ────
router.post('/admin/inventory/import-excel', upload.single('file'), asyncRoute(async (req, res, ok, err) => {
  if (!req.file) return err('No file uploaded (field name: file)')

  const db = await connectToMongo()
  const col = db.collection('master_inventory')
  await col.createIndex({ sku_code: 1 }, { unique: true })

  const wb = XLSX.read(req.file.buffer, { type: 'buffer' })
  const sheetName = wb.SheetNames.find(n => n.toLowerCase().includes('master')) || wb.SheetNames[0]
  const ws = wb.Sheets[sheetName]
  if (!ws) return err(`Sheet not found in workbook. Sheets: ${wb.SheetNames.join(', ')}`, 400)

  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' })
  let imported = 0, updated = 0, errors = 0

  for (const r of rows) {
    try {
      const sku_code = String(r['SKU Code'] || r['sku_code'] || '').trim()
      if (!sku_code) { errors++; continue }

      const doc = {
        sku_code,
        category:       String(r['Category'] || '').trim(),
        subcategory:    String(r['Subcategory'] || '').trim(),
        brand_supplier: String(r['Brand / Supplier Reference'] || '').trim(),
        material:       String(r['Material'] || '').trim(),
        finish:         String(r['Finish'] || '').trim(),
        shape:          String(r['Shape'] || '').trim(),
        size_inches:    Number(r['Size (inches)']) || 0,
        color:          String(r['Colour'] || r['Color'] || '').trim(),
        pack_quantity:  Number(r['Pack Quantity']) || 0,
        cost_price_pack:        Number(r['Cost Price Pack (INR)']) || 0,
        per_unit_cost:          Number(r['Per Unit Cost (INR)']) || 0,
        selling_price_pack:     Number(r['Selling Price Pack (INR)']) || 0,
        selling_price_per_unit: Number(r['Selling Price Per Unit (INR)']) || 0,
        city_availability:      String(r['City Availability'] || '').trim(),
        inventory_status:       String(r['Inventory Status'] || 'Active').trim(),
        budget_fit:             String(r['Budget Fit'] || '').trim(),
        source_url:             String(r['Source URL'] || '').trim(),
        image_search_ref:       String(r['Image Search Reference'] || '').trim(),
        ai_usage_notes:         String(r['AI Usage Notes'] || '').trim(),
        active: true,
        updated_at: new Date(),
      }

      const existing = await col.findOne({ sku_code })
      if (existing) {
        await col.updateOne({ sku_code }, { $set: doc })
        updated++
      } else {
        doc.id = uuidv4()
        doc.stock_count = 0
        doc.reorder_threshold = 50
        doc.created_at = new Date()
        await col.insertOne(doc)
        imported++
      }
    } catch (e) {
      console.error('[Import]', e.message)
      errors++
    }
  }

  return ok({ imported, updated, errors, total_rows: rows.length })
}))

export default router
