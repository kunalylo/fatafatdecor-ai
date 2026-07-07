// Reference-design selection — shared by /designs/generate-from-reference (new clients)
// and /designs/generate (legacy clients upgraded to the reference pipeline).
//
// Goals (in order):
//   1. Stay close to the customer's budget — prefer the exact bracket, then ±1, then ±2.
//      Never silently jump from a 3-5K request to a 30K design when anything nearer exists.
//   2. Variety — never deterministically return the same reference for the same inputs.
//      Ties are broken randomly among the top band, and references the user already
//      received recently are excluded when alternatives exist.
//   3. Respect occasion compatibility and theme preference like before.

import { BUDGET_BRACKETS } from './budget-brackets.js'

// Map customer occasion → compatible reference occasion variants
export const OCCASION_COMPATIBILITY = {
  birthday:     ['birthday', 'party'],
  anniversary:  ['anniversary', 'dinner'],
  wedding:      ['wedding'],
  dinner:       ['dinner', 'anniversary'],
  party:        ['party', 'birthday'],
  baby_shower:  ['baby_shower'],
  engagement:   ['engagement'],
  corporate:    ['corporate', 'store_opening'],
  festival:     ['festival'],
  housewarming: ['housewarming'],
  new_year:     ['new_year', 'party'],
  store_opening: ['store_opening', 'corporate'],
}

const bracketIndex = Object.fromEntries(BUDGET_BRACKETS.map((b, i) => [b.id, i]))

/**
 * Pick the best reference design for a request.
 *
 * @returns {Promise<object|null>} the FULL picked reference doc, or null when no
 *          approved references exist at all.
 */
export async function pickReference(db, { occasion, bracketId, themePreference = '', userId = null }) {
  const variants = OCCASION_COMPATIBILITY[occasion] || [occasion]
  const reqIdx = bracketIndex[bracketId] ?? 0

  // Light projection — score on metadata only, fetch the full doc after picking.
  const all = await db.collection('reference_designs')
    .find({ active: true, status: 'approved' })
    .project({ id: 1, occasion: 1, occasions: 1, budget_bracket: 1, theme: 1, use_count: 1, margin_percent: 1 })
    .toArray()
  if (all.length === 0) return null

  // References this user already received recently — avoid repeats on regenerate.
  let recentlyUsed = new Set()
  if (userId) {
    const recent = await db.collection('designs')
      .find({ user_id: userId, reference_design_id: { $ne: null } })
      .sort({ created_at: -1 }).limit(8)
      .project({ reference_design_id: 1 }).toArray()
    recentlyUsed = new Set(recent.map(d => d.reference_design_id))
  }

  const occMatches = (r) => {
    const occs = (r.occasions && r.occasions.length ? r.occasions : [r.occasion]).filter(Boolean)
    return occs.some(o => variants.includes(o))
  }
  const dist = (r) => {
    const idx = bracketIndex[r.budget_bracket]
    return idx === undefined ? 99 : Math.abs(idx - reqIdx)
  }

  // Candidate pools, best-fit first. Take the FIRST non-empty pool.
  const pools = [
    all.filter(r => occMatches(r) && dist(r) === 0),   // right occasion, right budget
    all.filter(r => occMatches(r) && dist(r) <= 1),    // right occasion, ±1 bracket
    all.filter(r => dist(r) === 0),                    // right budget, any occasion
    all.filter(r => occMatches(r) && dist(r) <= 2),    // right occasion, ±2 brackets
    all.filter(r => dist(r) <= 1),                     // ±1 bracket, any occasion
    all.filter(r => occMatches(r)),                    // right occasion, any budget
    all,                                               // absolute last resort
  ]
  let pool = pools.find(p => p.length > 0) || all

  // Freshness: drop references the user already received — only if alternatives remain.
  if (recentlyUsed.size > 0) {
    const fresh = pool.filter(r => !recentlyUsed.has(r.id))
    if (fresh.length > 0) pool = fresh
  }

  // Score within the pool
  const themeLower = String(themePreference || '').toLowerCase()
  const scored = pool.map(r => {
    let score = 0
    const exactOcc = r.occasion === occasion || (r.occasions || []).includes(occasion)
    if (exactOcc) score += 40
    else if (occMatches(r)) score += 20
    score += Math.max(0, 30 - dist(r) * 15)                                   // bracket proximity
    if (themeLower && String(r.theme || '').toLowerCase().includes(themeLower)) score += 20
    if (typeof r.margin_percent === 'number' && r.margin_percent > 60) score += 5
    return { r, score }
  })
  scored.sort((a, b) => b.score - a.score)

  // Variety: random pick among the top band (within 10 points of the best) so equal-quality
  // references rotate instead of the same one winning every time.
  const best = scored[0].score
  const band = scored.filter(s => s.score >= best - 10)
  const chosen = band[Math.floor(Math.random() * band.length)].r

  // Return the full document (image_url, detected_items, snapshot pricing fields…)
  return db.collection('reference_designs').findOne({ id: chosen.id })
}
