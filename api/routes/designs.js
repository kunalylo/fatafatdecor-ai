import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { connectToMongo } from '../db.js'
import { requireUser } from '../jwt.js'
import { asyncRoute } from '../helpers.js'
import { AI_SERVICE_URL, IMAGEKIT_PRIVATE_KEY } from '../config.js'

const router = Router()

const VALID_ROOM_TYPES = ['Dining Room','Living Room','Bedroom','Balcony','Garden','Hall','Office','Terrace']
const VALID_OCCASIONS  = ['birthday','anniversary','wedding','dinner','party','baby_shower','engagement','corporate','festival','housewarming']
const VALID_BUDGETS    = [[3000,5000],[5000,10000],[10000,15000],[15000,20000],[20000,30000],[30000,50000]]

async function uploadToImageKit(base64OrUrl, designId) {
  try {
    const falBase64 = base64OrUrl.startsWith('data:')
      ? base64OrUrl.split(',')[1]
      : Buffer.from(await (await fetch(base64OrUrl)).arrayBuffer()).toString('base64')
    const ikAuth = Buffer.from(IMAGEKIT_PRIVATE_KEY + ':').toString('base64')
    const ikBody = new URLSearchParams()
    ikBody.append('file', falBase64)
    ikBody.append('fileName', `design_${designId}.jpg`)
    ikBody.append('folder', '/generated')
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

  const user = await db.collection('users').findOne({ id: user_id })
  if (!user) return err('User not found', 404)
  if (user.credits <= 0) return err('No credits remaining. Please purchase credits.', 402)

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
    const aiTimeout  = setTimeout(() => controller.abort(), 90000)
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
    if (isTimeout) return err('AI generation timed out. Please try again.', 500)

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
      const isTo = fbErr.name === 'AbortError' || fbErr.message?.includes('aborted')
      return err(isTo ? 'AI generation timed out. Please try again.' : 'AI image generation failed. Please try again.', 500)
    }
  }

  const creditResult = await db.collection('users').findOneAndUpdate(
    { id: user_id, credits: { $gt: 0 } },
    { $inc: { credits: -1 } },
    { returnDocument: 'after' }
  )
  if (!creditResult) return err('No credits remaining. Please purchase credits.', 402)

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
  return ok({ ...cleanDesign, remaining_credits: creditResult.credits, kit_used: !!selectedKit })
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
