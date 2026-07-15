// Default cost estimates when AI detects an item that has no inventory match.
// Used to auto-create a master_inventory SKU on the fly. Admin can edit the
// cost later — these are educated guesses based on category + size.

const BASE_COST_BY_TYPE = {
  latex_balloon:  3,    // per 12" balloon, typical wholesale ~Rs 1-5
  foil_balloon:   50,   // mylar shapes typical ~Rs 30-200
  backdrop:       250,  // foil curtains / net backdrops ~Rs 100-500
  light:          200,  // led curtain / fairy lights
  prop:           150,  // misc props (signs, frames)
  flower:         80,
  other:          50,
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
  const type = String(detection.type || 'other').toLowerCase()
  const base = BASE_COST_BY_TYPE[type] ?? BASE_COST_BY_TYPE.other

  let cost = base
  cost *= SIZE_MULTIPLIER(detection.size_inches)

  if (type === 'foil_balloon') {
    const shape = String(detection.shape || 'other').toLowerCase()
    cost *= FOIL_SHAPE_MULTIPLIER[shape] ?? 1.0
  }

  // Clamp to reasonable bounds
  cost = Math.max(1, Math.min(cost, 3000))
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
