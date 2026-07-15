// Default cost estimates when AI detects an item that has no inventory match.
// Used to auto-create a master_inventory SKU on the fly. Admin can edit the
// cost later — these are educated guesses based on category + size.

const BASE_COST_BY_TYPE = {
  latex_balloon:  3,    // per 12" balloon, typical wholesale ~Rs 1-5
  foil_balloon:   50,   // mylar shapes typical ~Rs 30-200
  mirror_ball:    1800, // inflatable PVC chrome sphere — reusable premium prop
  structure:      2500, // shimmer wall panel / frame / plinth / panel wall
  backdrop:       250,  // foil curtains / net backdrops ~Rs 100-500
  light:          200,  // led curtain / fairy lights
  prop:           150,  // misc props (signs, frames)
  flower:         80,
  other:          50,
}

// Per-unit costs for premium subtypes (Indian market, reusable rental value).
// These items carry most of a premium design's cost — the generic type default
// (a Rs 150 "prop") made Rs 40,000 designs look like they used Rs 600 of material.
const SUBTYPE_COST = {
  shimmer_wall:      5000,
  sequin_wall:       5000,
  sequin_panel:      5000,
  panel_wall:        4500,
  pillow_wall:       4500,
  frame:             2000,
  backdrop_frame:    2000,
  arch_frame:        2500,
  plinth:            1200,
  pedestal:          1200,
  platform:          1500,
  cylinder_stand:    1200,
  letter_cube:       1500,
  letter_blocks:     1500,
  inflatable_number: 3000,
  inflatable_letter: 3000,
  neon_sign:         2500,
  led_strip:         600,
  led_curtain:       800,
  fairy_lights:      250,
  spotlight:         500,
  disco_ball:        700,
  balloon_column:    400,
  bobo_bubble:       60,
  orbz:              120,
}

// mirror_ball cost scales steeply with diameter (inflatable PVC chrome spheres)
const MIRROR_BALL_COST = (sizeInches) => {
  const s = Number(sizeInches) || 24
  if (s <= 16) return 900
  if (s <= 24) return 1500
  if (s <= 36) return 2600
  if (s <= 48) return 4200
  return 6000
}

const SIZE_MULTIPLIER = (sizeInches) => {
  const s = Number(sizeInches) || 0
  if (s <= 5)  return 0.5
  if (s <= 10) return 0.8
  if (s <= 12) return 1.0
  if (s <= 18) return 2.5
  if (s <= 24) return 6.0
  if (s <= 36) return 12.0
  return 20.0
}

// Foil character (number/letter) multiplier — they cost more than plain shapes
const FOIL_SHAPE_MULTIPLIER = {
  number: 4,
  letter: 4,
  bottle: 8,    // large champagne bottle foils
  heart:  1.5,
  star:   1.5,
  round:  1.0,
  other:  1.5,
}

/**
 * Estimate the per-unit cost of a detected item that has no inventory match.
 * Tuned for Indian decor wholesale market.
 */
export function estimateUnitCost(detection) {
  const type    = String(detection.type || 'other').toLowerCase()
  const subtype = String(detection.subtype || '').toLowerCase().replace(/[\s-]+/g, '_')

  // The vision model estimates each item's real cost from the photo (it can see
  // the actual size/quality), which beats any static table. Trust it when sane;
  // the tables below remain the fallback. Admin can refine in All Items.
  const est = Number(detection.est_unit_cost_inr) || 0
  if (est >= 1 && est <= 12000) return Math.round(est * 100) / 100

  // Mirror balls price by diameter, not by the latex size curve.
  if (type === 'mirror_ball') return MIRROR_BALL_COST(detection.size_inches)

  // Known premium subtype → flat realistic cost (no size multiplier: a shimmer
  // wall panel costs the same whether or not a size was estimated).
  if (SUBTYPE_COST[subtype] !== undefined) return SUBTYPE_COST[subtype]

  const base = BASE_COST_BY_TYPE[type] ?? BASE_COST_BY_TYPE.other

  let cost = base
  // Structures are priced per unit, not scaled by a balloon size curve.
  if (type !== 'structure') cost *= SIZE_MULTIPLIER(detection.size_inches)

  if (type === 'foil_balloon') {
    const shape = String(detection.shape || 'other').toLowerCase()
    cost *= FOIL_SHAPE_MULTIPLIER[shape] ?? 1.0
  }

  // Clamp to reasonable bounds (premium structures may legitimately be costly)
  const ceiling = ['structure', 'mirror_ball'].includes(type) ? 12000 : 3000
  cost = Math.max(1, Math.min(cost, ceiling))
  return Math.round(cost * 100) / 100
}

/**
 * Build a stable SKU code for an auto-created item.
 * Format: FD-AUTO-{TYPE}-{SHAPE/SUBTYPE}-{COLOR}-{SIZE}-{FINISH}
 * The shape/subtype segment is what makes "pink butterfly foil" and
 * "pink round foil" different SKUs instead of colliding.
 */
export function buildAutoSkuCode(detection) {
  const shapeSeg = String(detection.subtype || detection.shape || '')
    .toUpperCase().replace(/[\s_]+/g, '')
  // Text-bearing items (signs, banners, number/letter sets) must get DISTINCT
  // SKUs per text — otherwise the '13' neon and the 'Happy Birthday' neon
  // collide on one code and the second one inherits the first one's identity.
  const textSeg = String(detection.text_content || detection.character || '')
    .toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 14)
  const parts = [
    'FD-AUTO',
    String(detection.type || 'other').toUpperCase().replace(/_/g, ''),
    shapeSeg || null,
    String(detection.color || 'X').toUpperCase().replace(/\s+/g, ''),
    String(detection.size_inches || 0) + 'IN',
    String(detection.finish || 'X').toUpperCase().replace(/\s+/g, ''),
    textSeg ? 'TXT' + textSeg : null,
  ].filter(Boolean)
  // Sanitize: alphanumeric + hyphens only
  return parts.join('-').replace(/[^A-Z0-9-]/g, '').slice(0, 80)
}

/**
 * Human-readable name for an auto-created item — what shows in item lists.
 * "Pink Butterfly Foil Balloon 20\"", "Gold Letter Banner \"HAPPY BIRTHDAY\"".
 */
export function buildAutoDisplayName(detection) {
  const cap = (s) => String(s || '').trim().replace(/[_]+/g, ' ')
    .replace(/\w\S*/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase())
  const typeName = {
    latex_balloon: 'Latex Balloon', foil_balloon: 'Foil Balloon',
    mirror_ball: 'Inflatable Mirror Ball', structure: 'Structure',
    backdrop: 'Backdrop', light: 'Light', prop: 'Prop',
    flower: 'Flower Decor', other: 'Decor Item',
  }[String(detection.type || 'other').toLowerCase()] || 'Decor Item'
  const shapeWord = cap(detection.subtype || detection.shape || '')
  const bits = [
    cap(detection.color),
    shapeWord && !typeName.toLowerCase().includes(shapeWord.toLowerCase()) ? shapeWord : '',
    typeName,
    detection.size_inches ? `${detection.size_inches}"` : '',
  ].filter(Boolean)
  let name = bits.join(' ').replace(/\s+/g, ' ').trim()
  const text = String(detection.text_content || detection.character || '').trim()
  if (text) name += ` "${text}"`
  return name
}
