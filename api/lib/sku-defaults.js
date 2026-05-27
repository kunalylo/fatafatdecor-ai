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
 * Format: FD-AUTO-{TYPE}-{COLOR}-{SIZE}-{FINISH}
 */
export function buildAutoSkuCode(detection) {
  const parts = [
    'FD-AUTO',
    String(detection.type || 'other').toUpperCase().replace(/_/g, ''),
    String(detection.color || 'X').toUpperCase().replace(/\s+/g, ''),
    String(detection.size_inches || 0) + 'IN',
    String(detection.finish || 'X').toUpperCase().replace(/\s+/g, ''),
  ]
  // Sanitize: alphanumeric + hyphens only
  return parts.join('-').replace(/[^A-Z0-9-]/g, '').slice(0, 80)
}
