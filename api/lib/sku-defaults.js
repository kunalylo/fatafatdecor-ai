// Default cost estimates when AI detects an item that has no inventory match.
// Used to auto-create a master_inventory SKU on the fly. Admin can edit the
// cost later — these are educated guesses based on category + size.

// COST BASIS: what ONE unit costs US for ONE event.
//   • consumables (balloons, streamers, printed panels) = purchase cost
//   • reusable assets (mirror balls, walls, frames, plinths) = PER-EVENT RENTAL
//     value, NOT the purchase price — we own them and reuse them across jobs.
// Using purchase prices here made a Rs 33,000 design show Rs 113,000 of "materials".
const BASE_COST_BY_TYPE = {
  latex_balloon:  3,    // per 12" balloon, typical wholesale ~Rs 1-5
  foil_balloon:   50,   // mylar shapes typical ~Rs 30-200
  mirror_ball:    480,  // per-event rental of an inflatable chrome sphere
  structure:      900,  // per-event rental of a wall panel / frame / plinth
  backdrop:       250,  // foil curtains / net backdrops ~Rs 100-500
  light:          200,  // led curtain / fairy lights
  prop:           150,  // misc props (signs, frames)
  flower:         80,
  other:          50,
}

// Per-event cost for premium subtypes (Indian market). Reusable items are priced
// at rental value; consumable/custom items at purchase.
const SUBTYPE_COST = {
  shimmer_wall:      1200,   // per ~2ft x 8ft panel, per event
  sequin_wall:       1200,
  sequin_panel:      1200,
  panel_wall:        5500,   // whole inflatable pillow/panel wall (~12ft x 9ft)
  pillow_wall:       5500,
  frame:             800,
  backdrop_frame:    800,
  arch_frame:        900,
  // Basic cylinder/plinth stands are everyday rentals — a set of three is
  // standard even on a Rs 3,400 birthday backdrop. Keep them cheap and REAL:
  // the decorator must still be told to bring them.
  plinth:            250,
  pedestal:          250,
  platform:          300,
  cylinder_stand:    250,
  letter_cube:       500,
  letter_blocks:     500,
  inflatable_number: 1200,
  inflatable_letter: 1200,
  custom_printed_panel: 1500,  // consumable — made per event
  // Letter/number BANNER sets are quoted per letter: a "HAPPY BIRTHDAY" foil
  // banner is ~Rs 250 for the set, not 13 separate Rs 75 props.
  letter_banner:     20,   // per letter (party-shop LED/foil banner set)
  letter_garland:    20,
  number_banner:     20,
  light_up_letters:  30,   // per letter — marquee/battery letters, NOT custom neon
  neon_sign:         2200,
  led_strip:         600,
  neon_flex_rope:    1300,
  led_curtain:       800,
  fairy_lights:      250,
  spotlight:         500,
  disco_ball:        300,
  balloon_column:    400,
  floor_covering:    1800,
  rigging:           700,
  bobo_bubble:       60,
  orbz:              120,
}

// Inflatable chrome sphere — PER-EVENT RENTAL by diameter (not purchase price).
const MIRROR_BALL_COST = (sizeInches) => {
  const s = Number(sizeInches) || 24
  if (s <= 12) return 120
  if (s <= 18) return 180
  if (s <= 24) return 260
  if (s <= 36) return 480
  if (s <= 48) return 750
  if (s <= 60) return 1100
  return 1500
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

// Foil/mylar barely scales with size the way latex does — an 18" round foil is
// ~Rs 45, not Rs 125. Keep foil growth gentle so big foils don't dominate a
// cheap design's cost (this is only the fallback; the vision estimate wins).
const FOIL_SIZE_MULTIPLIER = (sizeInches) => {
  const s = Number(sizeInches) || 18
  if (s <= 16) return 0.8
  if (s <= 18) return 1.0
  if (s <= 24) return 1.6
  if (s <= 32) return 2.4
  if (s <= 40) return 3.2
  return 4.0
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
  if (type === 'foil_balloon') {
    cost *= FOIL_SIZE_MULTIPLIER(detection.size_inches)
    const shape = String(detection.shape || 'other').toLowerCase()
    cost *= FOIL_SHAPE_MULTIPLIER[shape] ?? 1.0
  } else if (type !== 'structure') {
    // Structures are priced per unit, not scaled by a balloon size curve.
    cost *= SIZE_MULTIPLIER(detection.size_inches)
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
