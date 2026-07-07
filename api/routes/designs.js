import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { connectToMongo } from '../db.js'
import { requireUser } from '../jwt.js'
import { asyncRoute } from '../helpers.js'
import { AI_SERVICE_URL, IMAGEKIT_PRIVATE_KEY } from '../config.js'
import { BUDGET_BRACKETS, validBudgetTuples, findBracket, bracketForPrice } from '../lib/budget-brackets.js'
import { customerBreakdown, adminMargin } from '../lib/pricing-calc.js'
import { pickReference } from '../lib/reference-select.js'

const router = Router()

const VALID_ROOM_TYPES = ['Dining Room','Living Room','Bedroom','Balcony','Garden','Hall','Office','Terrace']
const VALID_OCCASIONS  = ['birthday','anniversary','wedding','dinner','party','baby_shower','engagement','corporate','festival','housewarming','new_year','store_opening']
const VALID_BUDGETS    = validBudgetTuples()

// Public endpoint: customer apps fetch the live bracket list so the UI stays in sync
router.get('/budget-brackets', asyncRoute(async (req, res, ok) => {
  return ok({ brackets: BUDGET_BRACKETS })
}))

async function uploadToImageKit(base64OrUrl, designId, folder = '/generated', fileName = null) {
  try {
    const falBase64 = base64OrUrl.startsWith('data:')
      ? base64OrUrl.split(',')[1]
      : Buffer.from(await (await fetch(base64OrUrl)).arrayBuffer()).toString('base64')
    const ikAuth = Buffer.from(IMAGEKIT_PRIVATE_KEY + ':').toString('base64')
    const ikBody = new URLSearchParams()
    ikBody.append('file', falBase64)
    ikBody.append('fileName', fileName || `design_${designId}.jpg`)
    ikBody.append('folder', folder)
    const ikRes  = await fetch('https://upload.imagekit.io/api/v1/files/upload', {
      method: 'POST',
      headers: { 'Authorization': `Basic ${ikAuth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: ikBody.toString(),
    })
    const ikData = await ikRes.json()
    if (!ikData.url) throw new Error('ImageKit upload failed: ' + JSON.stringify(ikData))
    return ikData.url
  } catch (e) {
    console.warn('[ImageKit] upload failed:', e.message)
    return null
  }
}

// POST /designs/generate — requires JWT
router.post('/designs/generate', requireUser, asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const user_id = req.userId
  const body = req.body
  const { room_type, occasion, description, original_image, budget_min, budget_max } = body
  if (!room_type || !occasion) return err('room_type and occasion required')

  if (!VALID_ROOM_TYPES.includes(room_type)) return err('Invalid room type', 400)
  if (!VALID_OCCASIONS.includes(occasion))   return err('Invalid occasion', 400)
  const bMin = Number(budget_min) || 3000
  const bMax = Number(budget_max) || 5000
  if (!VALID_BUDGETS.some(([mn, mx]) => mn === bMin && mx === bMax)) return err('Invalid budget range', 400)
  const safeDescription = description ? String(description).slice(0, 200) : ''

  // ── Deduct credit atomically BEFORE AI call (prevents race condition) ────
  const creditResult = await db.collection('users').findOneAndUpdate(
    { id: user_id, credits: { $gt: 0 } },
    { $inc: { credits: -1 } },
    { returnDocument: 'after' }
  )
  if (!creditResult) return err('No credits remaining. Please purchase credits.', 402)

  // ── Reference pipeline FIRST (server-side upgrade for old app builds) ──────
  // Old clients still call this legacy endpoint; give them the same reference-based
  // generation as new clients. The kit flow below remains only as a fallback when
  // no references exist or the style transfer fails — never worse than before.
  if (original_image && original_image.includes('base64')) {
    try {
      const bracket = findBracket(bMin, bMax) || bracketForPrice(bMax)
      const picked = await pickReference(db, { occasion, bracketId: bracket.id, themePreference: '', userId: user_id })
      if (picked) {
        const refDesignId = uuidv4()
        const originalUploadPromise = uploadToImageKit(original_image, refDesignId, '/rooms', `room_${refDesignId}.jpg`).catch(() => null)
        const controller = new AbortController()
        const timeout    = setTimeout(() => controller.abort(), 120000)
        const styleRes = await fetch(`${AI_SERVICE_URL}/style-transfer-from-reference`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            room_image_base64:   original_image,
            reference_image_url: picked.image_url,
            occasion, theme: picked.theme || '', room_type, description: safeDescription,
          }),
          signal: controller.signal,
        })
        clearTimeout(timeout)
        const data = await styleRes.json()
        if (data.success && data.image_url) {
          const [uploaded, roomUrl] = await Promise.all([
            uploadToImageKit(data.image_url, refDesignId),
            originalUploadPromise,
          ])
          const breakdown = customerBreakdown(picked.base_price)
          const snapshotItems = (picked.detected_items || []).map(i => ({
            id:               i.matched_sku_id || uuidv4(),
            matched_sku_code: i.matched_sku_code || null,
            name:             i.sku_name || i.raw_detection || 'Item',
            category:         i.category || '',
            quantity:         i.quantity || 1,
            unit_price:       i.unit_price || 0,
            line_price:       i.line_price || 0,
            is_removable:     false,   // legacy clients can't re-price removals
          }))
          // Legacy display items — old apps compute the grand total as Σ(items), so
          // include a fees+GST line to make that sum equal the real customer total.
          const legacyItems = snapshotItems.map(i => ({
            id: i.id, name: i.name, description: i.category || '', price: Number(i.unit_price) || 0,
            quantity: Number(i.quantity) || 1, category: i.category || '', color: '', size: '',
            image_url: '', is_kit_item: false, is_rentable: false,
          }))
          const itemsSum = legacyItems.reduce((s, i) => s + i.price * i.quantity, 0)
          const feeLine  = Math.max(0, +(breakdown.total - itemsSum).toFixed(2))   // exact — Σitems === total_cost
          if (feeLine > 0) legacyItems.push({
            id: uuidv4(), name: 'Setup, transport, fees & GST (18%)', description: 'Delivery, setup, platform fees and GST',
            price: feeLine, quantity: 1, category: 'fees', color: '', size: '', image_url: '', is_kit_item: false, is_rentable: false,
          })
          const design = {
            id: refDesignId, user_id, room_type, occasion, description: safeDescription,
            original_image: '[uploaded]',
            original_image_url: roomUrl,
            decorated_image: uploaded || data.image_url,
            reference_design_id:     picked.id,
            reference_image_url:     picked.image_url,
            reference_thumbnail_url: picked.thumbnail_url || picked.image_url,
            reference_price:         picked.base_price,
            snapshot: {
              items: snapshotItems,
              items_price_total: picked.items_price_total || 0,
              items_cost_total:  picked.items_cost_total  || 0,
              customer_breakdown: breakdown,
              base_price: picked.base_price,
              budget_bracket: picked.budget_bracket,
            },
            customer_breakdown: breakdown,
            decoration_total:   breakdown.decoration_total,
            total_cost:         breakdown.total,
            // Legacy-shape fields so old app builds render items + totals correctly
            kit_id: null, kit_name: null, kit_items: [], kit_cost: 0,
            addon_items: legacyItems, addon_cost: breakdown.total,
            items_used:  legacyItems,
            ai_selected: true, status: 'generated', flow: 'reference', created_at: new Date(),
          }
          await db.collection('designs').insertOne(design)
          await db.collection('reference_designs').updateOne({ id: picked.id }, { $inc: { view_count: 1 } })
          const refUser = await db.collection('users').findOne({ id: user_id })
          const { _id, ...cleanRef } = design
          return ok({ ...cleanRef, remaining_credits: refUser?.credits ?? 0, kit_used: false })
        }
        console.warn('[designs/generate] style-transfer failed, falling back to kit flow:', data.detail || 'no image')
      } else {
        console.warn('[designs/generate] no approved references — using kit flow')
      }
    } catch (e) {
      console.warn('[designs/generate] reference path error, falling back to kit flow:', e.message)
    }
  }

  const [allKits, allItems, allRentItems] = await Promise.all([
    db.collection('decoration_kits').find({ active: true }).toArray(),
    db.collection('items').find({ stock_count: { $gt: 0 } }).toArray(),
    bMax > 5000 ? db.collection('rent_items').find({ active: true }).toArray() : Promise.resolve([]),
  ])
  if (allItems.length === 0) return err('No decoration items in database. Please seed first.', 500)

  const toTagStr = (v) => Array.isArray(v) ? v.join(', ') : (v || '')
  const kitsForAI  = allKits.map(k => ({ id: k.id, name: k.name || '', occasion_tags: toTagStr(k.occasion_tags), selling_total: Number(k.selling_total || k.final_price || 0), color_theme: k.color_theme || '' }))
  const itemsForAI = allItems.map(i => ({ id: i.id, name: i.name || '', category: i.category || '', color: i.type_finish || i.color || '', price: i.selling_price_unit || i.price || 0, size: i.size || '' }))
  const rentForAI  = allRentItems.map(r => ({ id: r.id, name: r.name || '', category: r.category || '', price: r.selling_price || r.rental_cost || 0 }))

  const designId = uuidv4()
  let decoratedImageUrl = null
  let selectedKit = null, kitItems = [], kitCost = 0
  let addOnItems = [], addOnCost = 0, aiSucceeded = false

  try {
    const controller = new AbortController()
    // High-fidelity gpt-image-1 (input_fidelity=high + quality=high + non-square sizes)
    // takes longer than the old fast path — allow up to 150s before refunding the credit.
    const aiTimeout  = setTimeout(() => controller.abort(), 150000)
    const aiRes = await fetch(`${AI_SERVICE_URL}/smart-generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        budget_min: bMin, budget_max: bMax, occasion, room_type,
        description: safeDescription,
        image_base64: (original_image && original_image.includes('base64')) ? original_image : null,
        kits: kitsForAI, items: itemsForAI, rent_items: rentForAI,
      }),
      signal: controller.signal,
    })
    clearTimeout(aiTimeout)
    const aiData = await aiRes.json()
    if (!aiData.success || !aiData.image_url) throw new Error(aiData.detail || 'AI generation failed')

    const selKitId   = aiData.selected_kit_id
    const selItemIds = new Set(aiData.selected_item_ids || [])
    const selRentIds = new Set(aiData.selected_rent_ids || [])

    selectedKit = allKits.find(k => k.id === selKitId) || null
    kitCost     = selectedKit ? (selectedKit.selling_total || selectedKit.final_price || 0) : 0
    kitItems    = selectedKit
      ? (selectedKit.bom || selectedKit.kit_items || []).map(bi => ({ id: uuidv4(), name: bi.item || bi.name || 'Item', description: `${bi.item || bi.name || 'Item'} - ${bi.uom || 'pc'}`, price: Number(bi.unit_purchase || bi.unit_price || 0), quantity: Number(bi.qty || bi.quantity || 1), category: 'kit_item', color: '', size: bi.uom || '', image_url: '', is_kit_item: true }))
      : []
    addOnItems = [
      ...allItems.filter(i => selItemIds.has(i.id)).map(i => ({ id: i.id, name: i.name, description: i.type_finish || i.category || '', price: i.selling_price_unit || i.price || 0, quantity: 1, category: i.category || '', color: i.type_finish || i.color || '', size: i.size || '', image_url: i.image_url || '', is_kit_item: false, is_rentable: false })),
      ...allRentItems.filter(r => selRentIds.has(r.id)).map(r => ({ id: r.id, name: r.name, description: r.category || '', price: r.selling_price || r.rental_cost || 0, quantity: 1, category: r.category || '', color: '', size: '', image_url: r.image_url || '', is_kit_item: false, is_rentable: true })),
    ]
    addOnCost = addOnItems.reduce((s, i) => s + (Number(i.price) || 0), 0)

    const uploaded = await uploadToImageKit(aiData.image_url, designId)
    decoratedImageUrl = uploaded || aiData.image_url
    aiSucceeded = true

  } catch (aiErr) {
    console.warn('[designs/generate] smart-generate failed, using fallback:', aiErr.message)
    const isTimeout = aiErr.name === 'AbortError' || aiErr.message?.includes('aborted')
    if (isTimeout) {
      // Refund credit on timeout
      await db.collection('users').updateOne({ id: user_id }, { $inc: { credits: 1 } })
      return err('AI generation timed out. Please try again.', 500)
    }

    const occasionMap = { birthday:['birthday','Birthday'], anniversary:['anniversary','Anniversary'], wedding:['wedding','Wedding'], baby_shower:['Ceremony','baby_shower'], engagement:['Proposal','engagement'], party:['birthday','Birthday'], housewarming:['housewarming'], corporate:['corporate'], dinner:['anniversary','Anniversary'], festival:['Holi','festival'] }
    const tagVariants = occasionMap[occasion] || [occasion]
    let matchingKits = allKits.filter(k => tagVariants.some(t => toTagStr(k.occasion_tags).toLowerCase().includes(t.toLowerCase())) && Number(k.selling_total || k.final_price || 0) <= bMax)
    if (matchingKits.length === 0) matchingKits = allKits.filter(k => Number(k.selling_total || k.final_price || 0) <= bMax)
    if (matchingKits.length > 0) {
      selectedKit = matchingKits.sort((a, b) => Number(b.selling_total || b.final_price || 0) - Number(a.selling_total || a.final_price || 0))[0]
      kitCost     = Number(selectedKit.selling_total || selectedKit.final_price || 0)
      kitItems    = (selectedKit.bom || selectedKit.kit_items || []).map(bi => ({ id: uuidv4(), name: bi.item || bi.name || 'Item', description: `${bi.item || bi.name || 'Item'} - ${bi.uom || 'pc'}`, price: Number(bi.unit_purchase || bi.unit_price || 0), quantity: Number(bi.qty || bi.quantity || 1), category: 'kit_item', color: '', size: bi.uom || '', image_url: '', is_kit_item: true }))
      let addonSpent = 0
      for (const item of allItems.sort(() => Math.random() - 0.5)) {
        if (addonSpent >= bMax - kitCost) break
        const isRentable = item.is_rentable || item.category === 'Neon Signs' || item.category === 'Lighting'
        if (bMax <= 5000 && isRentable) continue
        const price = item.selling_price_unit || item.price || 0
        if (price > 0 && addonSpent + price <= bMax - kitCost) { addOnItems.push({ id: item.id, name: item.name, description: item.type_finish || item.category || '', price, quantity: 1, category: item.category || '', color: item.type_finish || '', size: item.size || '', image_url: item.image_url || '', is_kit_item: false, is_rentable: isRentable }); addonSpent += price }
      }
      addOnCost = addonSpent
    }
    const allSelected = [...kitItems, ...addOnItems]
    const itemDescs   = allSelected.map(i => { const c = i.color && i.color.toLowerCase() !== 'mixed' ? `${i.color} ` : ''; return `${c}${(i.category || 'decoration').replace(/_/g, ' ')}` }).join(', ')
    const noText = 'CRITICAL: Do NOT write any text, words, letters, numbers, or labels anywhere in the image.'
    const hasUserImg = !!(original_image && original_image.includes('base64'))
    const fallbackPrompt = hasUserImg
      ? `Decorate this exact ${room_type} for a ${occasion}. Keep all existing furniture unchanged. Add: ${itemDescs}. ${safeDescription ? 'Special: ' + safeDescription + '.' : ''} ${noText} Photorealistic, warm lighting.`
      : `Professional photorealistic ${room_type} decorated for ${occasion}. Show: ${itemDescs}. ${safeDescription ? 'Special: ' + safeDescription + '.' : ''} ${noText} High quality, warm lighting, 4K.`
    try {
      const fbController = new AbortController()
      const fbTimeout    = setTimeout(() => fbController.abort(), 60000)
      const fbBody       = { prompt: fallbackPrompt }
      if (hasUserImg) fbBody.image_base64 = original_image
      const fbRes  = await fetch(`${AI_SERVICE_URL}/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fbBody), signal: fbController.signal })
      clearTimeout(fbTimeout)
      const fbData = await fbRes.json()
      if (!fbData.success) throw new Error(fbData.detail || 'Fallback generation failed')
      const uploaded = await uploadToImageKit(fbData.image_url, designId)
      decoratedImageUrl = uploaded || fbData.image_url
    } catch (fbErr) {
      // Refund credit on fallback failure
      await db.collection('users').updateOne({ id: user_id }, { $inc: { credits: 1 } })
      const isTo = fbErr.name === 'AbortError' || fbErr.message?.includes('aborted')
      return err(isTo ? 'AI generation timed out. Please try again.' : 'AI image generation failed. Please try again.', 500)
    }
  }

  // Credit was already deducted above — fetch updated count for response
  const updatedUser = await db.collection('users').findOne({ id: user_id })

  const allSelectedItems = [...kitItems, ...addOnItems]
  const totalCost        = kitCost + addOnCost
  const hasUserImage     = !!(original_image && original_image.includes('base64'))
  const design = {
    id: designId, user_id, room_type, occasion,
    description: safeDescription,
    original_image: hasUserImage ? '[uploaded]' : null,
    decorated_image: decoratedImageUrl,
    kit_id: selectedKit?.id || null, kit_name: selectedKit?.name || null,
    kit_items: kitItems, kit_cost: kitCost,
    addon_items: addOnItems, addon_cost: addOnCost,
    items_used: allSelectedItems, total_cost: totalCost,
    ai_selected: aiSucceeded, status: 'generated', created_at: new Date(),
  }
  await db.collection('designs').insertOne(design)
  const { _id, ...cleanDesign } = design
  return ok({ ...cleanDesign, remaining_credits: updatedUser?.credits ?? 0, kit_used: !!selectedKit })
}))


// ===================================================================
// NEW: POST /designs/generate-from-reference
// Customer flow — picks best matching reference design + style-transfers
// it onto their room photo. Replaces the kit-based /designs/generate
// once customer apps cut over.
// ===================================================================

router.post('/designs/generate-from-reference', requireUser, asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const user_id = req.userId
  const {
    room_type, occasion, description, original_image,
    budget_min, budget_max, theme_preference,
  } = req.body

  if (!room_type || !occasion) return err('room_type and occasion required')
  if (!original_image || !original_image.includes('base64')) {
    return err('Room photo required (original_image as data URL)')
  }
  if (!VALID_ROOM_TYPES.includes(room_type)) return err('Invalid room type', 400)
  if (!VALID_OCCASIONS.includes(occasion))   return err('Invalid occasion', 400)
  const bMin = Number(budget_min) || 3000
  const bMax = Number(budget_max) || 5000
  if (!VALID_BUDGETS.some(([mn, mx]) => mn === bMin && mx === bMax)) return err('Invalid budget range', 400)
  const bracket = findBracket(bMin, bMax)
  if (!bracket) return err('Could not identify bracket for given budget range', 400)
  const safeDescription = description ? String(description).slice(0, 200) : ''

  // ── Atomic credit deduction (same contract as legacy endpoint) ──────
  const creditResult = await db.collection('users').findOneAndUpdate(
    { id: user_id, credits: { $gt: 0 } },
    { $inc: { credits: -1 } },
    { returnDocument: 'after' },
  )
  if (!creditResult) return err('No credits remaining. Please purchase credits.', 402)

  // ── Pick the best reference (bracket-proximity + variety + per-user freshness) ──
  const picked = await pickReference(db, {
    occasion,
    bracketId: bracket.id,
    themePreference: theme_preference,
    userId: user_id,
  })
  if (!picked) {
    // Refund credit — no approved references exist at all
    await db.collection('users').updateOne({ id: user_id }, { $inc: { credits: 1 } })
    return err('No matching reference designs available for that budget + occasion yet. Please try a different combination or check back soon.', 404)
  }

  const designId = uuidv4()
  let decoratedImageUrl = null
  let originalImageUrl  = null
  let aiSucceeded = false

  // Upload customer's room photo to ImageKit in parallel with AI call.
  // This is what the decorator sees on the job sheet — the actual canvas
  // (raw photo of the customer's space) alongside the reference + AI preview.
  const originalUploadPromise = uploadToImageKit(
    original_image,
    designId,
    '/rooms',
    `room_${designId}.jpg`,
  ).catch(e => { console.warn('[generate-from-reference] room photo upload failed:', e.message); return null })

  // ── Style transfer via FastAPI multi-image gpt-image-1 ──────────────
  try {
    const controller = new AbortController()
    const timeout    = setTimeout(() => controller.abort(), 150000)
    const styleRes = await fetch(`${AI_SERVICE_URL}/style-transfer-from-reference`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        room_image_base64:   original_image,
        reference_image_url: picked.image_url,
        occasion,
        theme:        picked.theme || '',
        room_type,
        description:  safeDescription,
      }),
      signal: controller.signal,
    })
    clearTimeout(timeout)
    const data = await styleRes.json()
    if (!data.success || !data.image_url) throw new Error(data.detail || 'Style transfer failed')

    // Upload AI result + finalize the parallel room-photo upload
    const [uploaded, roomUrl] = await Promise.all([
      uploadToImageKit(data.image_url, designId),
      originalUploadPromise,
    ])
    decoratedImageUrl = uploaded || data.image_url
    originalImageUrl  = roomUrl
    aiSucceeded = true
  } catch (e) {
    console.error('[generate-from-reference] AI error:', e.message)
    await db.collection('users').updateOne({ id: user_id }, { $inc: { credits: 1 } })
    const isTimeout = e.name === 'AbortError' || e.message?.includes('aborted')
    return err(isTimeout
      ? 'AI generation timed out. Please try again.'
      : 'AI image generation failed. Please try again.', 500)
  }

  // ── Snapshot: freeze items + customer breakdown at generation time ──
  // Older references stored raw names like "Orange ribbon_bow 0\"" — clean for customers.
  const prettyItemName = (s) => String(s || '').replace(/_/g, ' ').replace(/\s+0"\s*$/, '').replace(/\s{2,}/g, ' ').trim()
  const snapshotItems = (picked.detected_items || []).map(i => ({
    id:               i.matched_sku_id || uuidv4(),
    matched_sku_code: i.matched_sku_code || null,
    name:             prettyItemName(i.sku_name || i.raw_detection) || 'Item',
    category:         i.category || '',
    quantity:         i.quantity || 1,
    unit_price:       i.unit_price || 0,        // 2x customer-facing price
    line_price:       i.line_price || 0,
    is_removable:     !!i.is_removable,
  }))
  const breakdown = customerBreakdown(picked.base_price)

  // ── Save the design ────────────────────────────────────────────────
  const updatedUser = await db.collection('users').findOne({ id: user_id })
  const design = {
    id: designId,
    user_id,
    room_type,
    occasion,
    description: safeDescription,
    original_image: '[uploaded]',          // legacy placeholder (raw data URL not stored)
    original_image_url: originalImageUrl,  // ImageKit URL of the customer's room photo — shown to decorator
    decorated_image: decoratedImageUrl,

    // Reference linkage
    reference_design_id: picked.id,
    reference_image_url: picked.image_url,
    reference_thumbnail_url: picked.thumbnail_url || picked.image_url,
    reference_price: picked.base_price,

    // Snapshot (frozen at generation time so pricing is stable)
    snapshot: {
      items: snapshotItems,
      items_price_total: picked.items_price_total || 0,
      items_cost_total:  picked.items_cost_total  || 0,
      customer_breakdown: breakdown,
      base_price: picked.base_price,
      budget_bracket: picked.budget_bracket,
    },

    // Customer-facing totals (mirrors snapshot for fast reads)
    total_cost: breakdown.total,
    decoration_total: breakdown.decoration_total,
    customer_breakdown: breakdown,

    ai_selected: aiSucceeded,
    status: 'generated',
    flow:   'reference',                  // distinguishes from legacy kit-based designs
    created_at: new Date(),
  }
  await db.collection('designs').insertOne(design)

  // ── Bump reference view count (analytics) ──────────────────────────
  await db.collection('reference_designs').updateOne(
    { id: picked.id },
    { $inc: { view_count: 1 } },
  )

  const { _id, ...clean } = design
  return ok({
    ...clean,
    remaining_credits: updatedUser?.credits ?? 0,
  })
}))


// GET /designs — requires JWT, only returns own designs
router.get('/designs', requireUser, asyncRoute(async (req, res, ok) => {
  const db      = await connectToMongo()
  const designs = await db.collection('designs').find({ user_id: req.userId }).sort({ created_at: -1 }).limit(50).toArray()
  return ok(designs.map(({ _id, ...d }) => ({
    ...d,
    decorated_image: d.decorated_image?.startsWith('data:') ? null : (d.decorated_image || null),
  })))
}))

// GET /designs/:id — requires JWT, only returns own design
router.get('/designs/:id', requireUser, asyncRoute(async (req, res, ok, err) => {
  const db     = await connectToMongo()
  const design = await db.collection('designs').findOne({ id: req.params.id })
  if (!design) return err('Design not found', 404)
  if (design.user_id !== req.userId) return err('Not authorized', 403)
  const { _id, ...clean } = design
  return ok(clean)
}))

export default router
