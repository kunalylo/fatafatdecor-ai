// ════════════════════════════════════════════════════════════════════
// CATALOG ROUTES — festivals, bulk, corporate, private (Velvet),
// gift categories/shop gifts, leads, offers.
//
// Collections are LAZY-SEEDED: on first read, if a collection is empty
// it is filled from api/lib/catalog-seeds.js. After that, admin edits
// live in Mongo (PUT/DELETE below) and seeds are never re-applied
// unless POST /admin/catalog/seed?force=1.
//
// Public reads never leak Velvet prices (vault pricing) — only
// admin GETs include them.
// ════════════════════════════════════════════════════════════════════
import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { connectToMongo } from '../db.js'
import { requireAdmin, requireUser, getUserIdFromRequest } from '../jwt.js'
import { asyncRoute } from '../helpers.js'
import {
  SEED_FESTIVALS, SEED_GIFT_CATEGORIES, SEED_SHOP_GIFTS,
  SEED_BULK_OCCASIONS, SEED_BULK_THEMES, SEED_BULK_TIERS, SEED_BULK_HAMPERS,
  SEED_CORPORATE_PACKAGES, SEED_CORPORATE_HAMPERS, SEED_CORPORATE_ADDONS,
  SEED_PRIVATE_TYPES, SEED_VELVET_ITEMS, SEED_VELVET_PERKS, SEED_VELVET_CODES,
  SEED_OFFERS, SEED_LEAD_STATUSES, SEED_TRENDING, SEED_TRENDING_HAMPERS,
} from '../lib/catalog-seeds.js'

const router = Router()

// Collection name → default seeds. Also acts as the admin-CRUD whitelist.
const SEEDS = {
  festivals:          SEED_FESTIVALS,
  gift_categories:    SEED_GIFT_CATEGORIES,
  shop_gifts:         SEED_SHOP_GIFTS,
  bulk_occasions:     SEED_BULK_OCCASIONS,
  bulk_themes:        SEED_BULK_THEMES,
  bulk_tiers:         SEED_BULK_TIERS,
  bulk_hampers:       SEED_BULK_HAMPERS,
  corporate_packages: SEED_CORPORATE_PACKAGES,
  corporate_hampers:  SEED_CORPORATE_HAMPERS,
  corporate_addons:   SEED_CORPORATE_ADDONS,
  private_types:      SEED_PRIVATE_TYPES,
  velvet_items:       SEED_VELVET_ITEMS,
  velvet_codes:       SEED_VELVET_CODES,
  offers:             SEED_OFFERS,
  trending:           SEED_TRENDING,
  trending_hampers:   SEED_TRENDING_HAMPERS,
}

async function ensureSeed(db, name) {
  const seeds = SEEDS[name]
  if (!seeds || !seeds.length) return
  const count = await db.collection(name).countDocuments()
  if (count === 0) {
    await db.collection(name).insertMany(seeds.map(s => ({ ...s, created_at: new Date() })))
  }
}

// One-time self-heal: docs seeded before an image-URL fix keep the dead URL in
// Mongo (lazy-seed never re-runs). Rewrite known-dead URLs to their working
// replacements once per process boot — idempotent, no admin token needed.
const DEAD_IMAGE_FIXES = [
  {
    dead: 'https://images.unsplash.com/photo-1605302700048-d3a78c0b7e90?w=600&q=85',
    fixes: {
      bulk_occasions:    'https://ik.imagekit.io/jcp2urr7b/content/02_home_page/04_festival_hampers/festival_hampers_diwali_roshni_collection_XoDXGLNtk.jpg',
      bulk_hampers:      'https://ik.imagekit.io/jcp2urr7b/content/02_home_page/04_festival_hampers/hero_and_product_image/diwali/golden_diya_and_sweets_WX9Hd_6Cp.jpg',
      corporate_hampers: 'https://ik.imagekit.io/jcp2urr7b/content/02_home_page/04_festival_hampers/hero_and_product_image/diwali/heritage_mithai_hamper_qZGGOXL0w.jpg',
    },
  },
]
let imageFixesApplied = false
async function applyImageFixes(db) {
  if (imageFixesApplied) return
  imageFixesApplied = true
  for (const { dead, fixes } of DEAD_IMAGE_FIXES) {
    for (const [coll, url] of Object.entries(fixes)) {
      await db.collection(coll).updateMany({ image: dead }, { $set: { image: url } }).catch(() => {})
    }
  }
}

async function getAll(db, name, { activeOnly = true } = {}) {
  await ensureSeed(db, name)
  await applyImageFixes(db)
  const q = activeOnly ? { $or: [{ active: true }, { active: { $exists: false } }] } : {}
  const docs = await db.collection(name).find(q).sort({ sortOrder: 1 }).toArray()
  return docs.map(({ _id, ...d }) => d)
}

// Days until the next occurrence of {month(1-12), day}
function daysToGo(month, day) {
  const now = new Date()
  let next = new Date(now.getFullYear(), month - 1, day)
  if (next < new Date(now.getFullYear(), now.getMonth(), now.getDate())) {
    next = new Date(now.getFullYear() + 1, month - 1, day)
  }
  return Math.max(0, Math.round((next - now) / 86400000))
}

// ── FESTIVALS ────────────────────────────────────────────────────────
router.get('/festivals', asyncRoute(async (req, res, ok) => {
  const db = await connectToMongo()
  const festivals = (await getAll(db, 'festivals')).map(f => ({ ...f, days: daysToGo(f.month, f.day) }))
  // Featured first (home carousel order), then soonest
  festivals.sort((a, b) => (Number(b.featured) - Number(a.featured)) || (a.days - b.days))
  return ok(festivals, 300)
}))

router.get('/festivals/:id', asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  await ensureSeed(db, 'festivals')
  const doc = await db.collection('festivals').findOne({ id: req.params.id })
  if (!doc) return err('Festival not found', 404)
  const { _id, ...f } = doc
  return ok({ ...f, days: daysToGo(f.month, f.day) }, 300)
}))

// ── GIFT CATEGORIES + SHOP GIFTS (content-pack visuals) ─────────────
router.get('/trending', asyncRoute(async (req, res, ok) => {
  const db = await connectToMongo()
  return ok(await getAll(db, 'trending'), 300)
}))

router.get('/trending-hampers', asyncRoute(async (req, res, ok) => {
  const db = await connectToMongo()
  return ok(await getAll(db, 'trending_hampers'), 300)
}))

router.get('/gift-categories', asyncRoute(async (req, res, ok) => {
  const db = await connectToMongo()
  return ok(await getAll(db, 'gift_categories'), 300)
}))

router.get('/shop-gifts', asyncRoute(async (req, res, ok) => {
  const db = await connectToMongo()
  return ok(await getAll(db, 'shop_gifts'), 300)
}))

// ── BULK + CORPORATE config bundles ─────────────────────────────────
router.get('/bulk/config', asyncRoute(async (req, res, ok) => {
  const db = await connectToMongo()
  const [occasions, themes, tiers, hampers] = await Promise.all([
    getAll(db, 'bulk_occasions'), getAll(db, 'bulk_themes'),
    getAll(db, 'bulk_tiers'), getAll(db, 'bulk_hampers'),
  ])
  return ok({ occasions, themes, tiers, hampers }, 300)
}))

router.get('/corporate/config', asyncRoute(async (req, res, ok) => {
  const db = await connectToMongo()
  const [packages, hampers, addons] = await Promise.all([
    getAll(db, 'corporate_packages'), getAll(db, 'corporate_hampers'), getAll(db, 'corporate_addons'),
  ])
  return ok({ packages, hampers, addons }, 300)
}))

// ── PRIVATE (Velvet) — prices are NEVER sent to customers ───────────
router.get('/private/collection', asyncRoute(async (req, res, ok) => {
  const db = await connectToMongo()
  const [types, items] = await Promise.all([
    getAll(db, 'private_types'), getAll(db, 'velvet_items'),
  ])
  const safeItems = items.map(({ price, ...rest }) => rest) // vault pricing — omit
  return ok({ types, perks: SEED_VELVET_PERKS, items: safeItems }, 300)
}))

router.post('/private/unlock', asyncRoute(async (req, res, ok, err) => {
  const code = String(req.body?.code || '').trim().toUpperCase()
  if (!code) return err('code required')
  const db = await connectToMongo()
  await ensureSeed(db, 'velvet_codes')
  const found = await db.collection('velvet_codes').findOne({ code, active: true })
  if (!found) return ok({ success: true, valid: false })
  const userId = await getUserIdFromRequest(req)
  if (userId) {
    await db.collection('users').updateOne({ id: userId }, { $set: { velvet_access: code, velvet_unlocked_at: new Date() } })
  }
  return ok({ success: true, valid: true })
}))

// ── LEADS (bulk / corporate / private / gift enquiries) ─────────────
const LEAD_TYPES = ['bulk', 'corporate', 'private', 'gift']

router.post('/leads', asyncRoute(async (req, res, ok, err) => {
  const b = req.body || {}
  const type = String(b.type || '').toLowerCase()
  if (!LEAD_TYPES.includes(type)) return err(`type must be one of ${LEAD_TYPES.join(', ')}`)
  const contactName  = String(b.contactName || b.name || '').trim()
  const contactPhone = String(b.contactPhone || b.phone || b.mobile || '').trim()
  if (!contactName && !contactPhone && !b.company) return err('contact name or phone required')

  const db = await connectToMongo()
  // EQ-#### display id via atomic counter
  const counter = await db.collection('counters').findOneAndUpdate(
    { id: 'lead' },
    { $inc: { seq: 1 }, $setOnInsert: { id: 'lead' } },
    { upsert: true, returnDocument: 'after' },
  )
  const seq = (counter?.seq ?? counter?.value?.seq ?? 1) + 1041
  const userId = await getUserIdFromRequest(req)

  const lead = {
    id: uuidv4(),
    leadId: `EQ-${seq}`,
    type,
    status: 'callback-pending',
    occasion:      b.occasion || b.occasionName || '',
    quantity:      Number(b.quantity || b.qty) || 0,
    budget:        String(b.budget || b.budgetPerUnit || b.budgetPerBox || b.budgetRange || b.budgetTotal || '').trim(),
    contactName, contactPhone,
    company:       b.company || '',
    email:         b.email || '',
    city:          b.city || '',
    deliveryDate:  b.deliveryDate || b.date || '',
    theme:         b.theme || '',
    packageId:     b.packageId || '',
    customization: !!b.customization,
    officeDecor:   !!b.officeDecor,
    branded:       !!b.branded,
    gst:           !!b.gst,
    notes:         String(b.notes || '').slice(0, 1000),
    referenceImage: b.referenceImage || '',
    logoImage:      b.logoImage || '',
    unlockedCode:   b.unlockedCode || '',
    user_id:        userId || null,
    created_at:     new Date(),
  }
  await db.collection('leads').insertOne(lead)
  const { _id, ...clean } = lead
  return ok({ success: true, lead: clean })
}))

router.get('/leads/mine', requireUser, asyncRoute(async (req, res, ok) => {
  const db = await connectToMongo()
  const docs = await db.collection('leads').find({ user_id: req.userId }).sort({ created_at: -1 }).limit(50).toArray()
  return ok(docs.map(({ _id, ...d }) => d))
}))

// ── OFFERS (display only — checkout integration is a separate step) ──
router.get('/offers', asyncRoute(async (req, res, ok) => {
  const db = await connectToMongo()
  return ok(await getAll(db, 'offers'), 300)
}))

// ════════════════════════════════════════════════════════════════════
// ADMIN
// ════════════════════════════════════════════════════════════════════
router.get('/admin/leads', requireAdmin, asyncRoute(async (req, res, ok) => {
  const db = await connectToMongo()
  const q = {}
  if (req.query.type)   q.type = req.query.type
  if (req.query.status) q.status = req.query.status
  const docs = await db.collection('leads').find(q).sort({ created_at: -1 }).limit(300).toArray()
  return ok({ leads: docs.map(({ _id, ...d }) => d), statuses: SEED_LEAD_STATUSES })
}))

router.patch('/admin/leads/:id', requireAdmin, asyncRoute(async (req, res, ok, err) => {
  const status = String(req.body?.status || '')
  if (!SEED_LEAD_STATUSES.some(s => s.id === status)) return err('invalid status')
  const db = await connectToMongo()
  const r = await db.collection('leads').updateOne(
    { $or: [{ id: req.params.id }, { leadId: req.params.id }] },
    { $set: { status, updated_at: new Date() } },
  )
  if (!r.matchedCount) return err('Lead not found', 404)
  return ok({ success: true })
}))

// Raw list (includes Velvet prices, inactive docs) for admin editors
router.get('/admin/catalog/:collection', requireAdmin, asyncRoute(async (req, res, ok, err) => {
  const name = req.params.collection
  if (!SEEDS[name]) return err('Unknown collection', 404)
  const db = await connectToMongo()
  await ensureSeed(db, name)
  const docs = await db.collection(name).find({}).sort({ sortOrder: 1 }).toArray()
  return ok(docs.map(({ _id, ...d }) => d))
}))

// Upsert one doc (partial merge by id; creates when new)
router.put('/admin/catalog/:collection', requireAdmin, asyncRoute(async (req, res, ok, err) => {
  const name = req.params.collection
  if (!SEEDS[name]) return err('Unknown collection', 404)
  const doc = req.body || {}
  const id = doc.id || doc.code || uuidv4()
  const db = await connectToMongo()
  await ensureSeed(db, name)
  const key = name === 'offers' || name === 'velvet_codes' ? 'code' : 'id'
  const keyVal = doc[key] || id
  const { _id, ...fields } = doc
  await db.collection(name).updateOne(
    { [key]: keyVal },
    { $set: { ...fields, [key]: keyVal, updated_at: new Date() }, $setOnInsert: { created_at: new Date() } },
    { upsert: true },
  )
  return ok({ success: true, [key]: keyVal })
}))

router.delete('/admin/catalog/:collection/:id', requireAdmin, asyncRoute(async (req, res, ok, err) => {
  const name = req.params.collection
  if (!SEEDS[name]) return err('Unknown collection', 404)
  const db = await connectToMongo()
  const key = name === 'offers' || name === 'velvet_codes' ? 'code' : 'id'
  const r = await db.collection(name).deleteOne({ [key]: req.params.id })
  if (!r.deletedCount) return err('Not found', 404)
  return ok({ success: true })
}))

// Force re-seed (upserts every seed doc; keeps admin extras)
router.post('/admin/catalog/seed', requireAdmin, asyncRoute(async (req, res, ok) => {
  const db = await connectToMongo()
  const force = req.query.force === '1'
  const summary = {}
  for (const [name, seeds] of Object.entries(SEEDS)) {
    if (force) {
      const key = name === 'offers' || name === 'velvet_codes' ? 'code' : 'id'
      for (const s of seeds) {
        await db.collection(name).updateOne(
          { [key]: s[key] },
          { $set: { ...s, updated_at: new Date() }, $setOnInsert: { created_at: new Date() } },
          { upsert: true },
        )
      }
      summary[name] = `upserted ${seeds.length}`
    } else {
      await ensureSeed(db, name)
      summary[name] = `count ${await db.collection(name).countDocuments()}`
    }
  }
  return ok({ success: true, summary })
}))

export default router
