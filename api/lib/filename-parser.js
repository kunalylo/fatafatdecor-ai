// Filename parser for reference design uploads.
//
// Expected filename pattern (flexible, semicolon/comma separated):
//   "Rs 9500 ; new year ; champagne theme ; gold silver ; indoor.jpg"
//   "Rs 8,500; birthday decoration, pink and gold theme; private event.jpg"
//   "8500 - birthday - pink - indoor.jpg"
//
// Extracts: price, occasion, theme, setup_type, room_hint, tags

const OCCASION_KEYWORDS = {
  birthday:     ['birthday', 'bday', 'b-day'],
  anniversary:  ['anniversary', 'anniv'],
  wedding:      ['wedding', 'shaadi', 'marriage'],
  baby_shower:  ['baby shower', 'baby_shower', 'godhbharai'],
  engagement:   ['engagement', 'sagai', 'proposal'],
  corporate:    ['corporate', 'office', 'company'],
  festival:     ['festival', 'diwali', 'holi', 'eid', 'christmas'],
  housewarming: ['housewarming', 'house warming', 'griha pravesh'],
  new_year:     ['new year', 'new_year', 'newyear', 'nye'],
  store_opening:['store opening', 'store_opening', 'inauguration', 'grand opening', 'shop opening'],
  party:        ['party', 'celebration'],
  dinner:       ['dinner', 'romantic dinner'],
}

const SETUP_KEYWORDS = {
  indoor:    ['indoor', 'inside', 'hall', 'living room', 'bedroom'],
  outdoor:   ['outdoor', 'outside', 'garden', 'lawn', 'terrace', 'rooftop'],
  private:   ['private', 'home', 'apartment', 'flat'],
  venue:     ['venue', 'hotel', 'banquet', 'restaurant'],
  corporate: ['office', 'corporate', 'workplace'],
  store:     ['store', 'shop', 'showroom'],
}

const ROOM_KEYWORDS = {
  'Living Room': ['living room', 'living-room', 'livingroom', 'lounge', 'drawing room'],
  'Dining Room': ['dining room', 'dining'],
  'Bedroom':     ['bedroom', 'bed room'],
  'Hall':        ['hall', 'banquet hall'],
  'Garden':      ['garden', 'lawn'],
  'Balcony':     ['balcony'],
  'Terrace':     ['terrace', 'rooftop'],
  'Office':      ['office', 'workplace'],
}

const COLOR_KEYWORDS = [
  'pink', 'gold', 'silver', 'rose gold', 'rose-gold', 'rosegold',
  'black', 'white', 'red', 'blue', 'green', 'purple', 'maroon',
  'pastel', 'chrome', 'metallic', 'champagne', 'ivory', 'peach',
  'mint', 'lavender', 'yellow', 'orange', 'navy', 'turquoise',
]

const TOOL_KEYWORDS = [
  'theme', 'decor', 'decoration', 'design', 'event', 'celebration',
  'premium', 'luxury', 'budget', 'simple', 'elegant',
]

// Words to strip while cleaning a segment to derive a theme
const THEME_STOP_WORDS = [
  'decoration', 'decorations', 'decor',
  'event', 'celebration', 'celebrations',
  'happy', 'beautiful', 'lovely', 'amazing',
  'a', 'an', 'the', 'and', 'with', 'for', 'of',
]

function stripExtension(filename) {
  return filename.replace(/\.(jpg|jpeg|png|webp|gif|bmp)$/i, '')
}

function extractPrice(text) {
  // Matches: "Rs 9500", "Rs. 9,500", "rs9500", "9500", "Rs 12000"
  const m = text.match(/(?:rs[\s.]*)?\s*([0-9][\d,]*)\s*(?:rs|rupees)?/i)
  if (!m) return null
  const n = parseInt(m[1].replace(/,/g, ''), 10)
  // Only treat as price if reasonable range (Rs 500 - Rs 200000)
  return (n >= 500 && n <= 200000) ? n : null
}

function findInText(text, keywordMap) {
  const lower = text.toLowerCase()
  for (const [key, variants] of Object.entries(keywordMap)) {
    for (const v of variants) {
      if (lower.includes(v.toLowerCase())) return key
    }
  }
  return null
}

/**
 * Find ALL keys whose any variant appears in the text.
 * Used for multi-value fields like occasions and setup types.
 */
function findAllInText(text, keywordMap) {
  const lower = text.toLowerCase()
  const found = []
  for (const [key, variants] of Object.entries(keywordMap)) {
    for (const v of variants) {
      if (lower.includes(v.toLowerCase())) {
        found.push(key)
        break
      }
    }
  }
  return found
}

function findColors(text) {
  const lower = text.toLowerCase()
  const found = []
  for (const c of COLOR_KEYWORDS) {
    if (lower.includes(c)) found.push(c.replace(/-/g, ' '))
  }
  return [...new Set(found)]
}

function extractTags(text) {
  const words = text.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !TOOL_KEYWORDS.includes(w) && !/^rs|^\d+$/.test(w))
  return [...new Set(words)]
}

/**
 * Clean a single filename segment into a usable theme phrase.
 * Strips "theme " prefix, generic noise words, occasion/setup keywords if needed.
 */
function cleanSegmentForTheme(segment) {
  let s = String(segment || '').toLowerCase()
    .replace(/^\s*theme\s+/, '')   // "theme birthday party" → "birthday party"
    .replace(/[^a-z0-9\s]/g, ' ')  // strip punctuation
    .replace(/\s+/g, ' ')
    .trim()

  // Drop generic noise words but keep occasion/style words
  const words = s.split(' ').filter(w => w.length >= 3 && !THEME_STOP_WORDS.includes(w))
  return words.join(' ').trim()
}

/**
 * Derive a theme from filename parts.
 * Priority:
 *   1. Explicit colors found anywhere in the filename
 *   2. Plus the first meaningful descriptive segment (e.g. "birthday party")
 *   3. Fallback: occasion + setup type ("birthday indoor")
 *   4. Fallback: "decoration"
 */
function deriveTheme(parts, colors, occasion, setupType) {
  const pieces = []

  if (colors.length > 0) {
    pieces.push(colors.join(' and '))
  }

  // First descriptive segment that isn't pure price
  for (const p of parts) {
    if (extractPrice(p) && p.replace(/[^a-z0-9]/gi, '').match(/^rs?\d+$/i)) continue
    const cleaned = cleanSegmentForTheme(p)
    if (cleaned.length >= 3 && !pieces.some(x => x.includes(cleaned))) {
      pieces.push(cleaned)
      break
    }
  }

  if (pieces.length === 0) {
    if (occasion) {
      const occWord = occasion.replace(/_/g, ' ')
      pieces.push(setupType ? `${setupType} ${occWord}` : occWord)
    } else {
      pieces.push('decoration')
    }
  }

  return pieces.join(' — ').replace(/\s+/g, ' ').trim()
}

/**
 * Parse a reference design filename.
 *
 * @param {string} filename - e.g. "Rs 9500 ; new year ; champagne theme ; indoor.jpg"
 * @returns {object} { price, occasion, theme, setup_type, room_hint, colors[], tags[], raw_filename }
 */
export function parseFilename(filename) {
  if (!filename) {
    return { price: null, occasion: null, theme: null, setup_type: null, room_hint: null, colors: [], tags: [], raw_filename: '' }
  }

  const raw = String(filename).trim()
  const base = stripExtension(raw)

  // Split on common separators: semicolon, comma, pipe, hyphen-with-spaces
  const parts = base.split(/\s*[;|]\s*|\s+-\s+/).map(s => s.trim()).filter(Boolean)

  // Extract price — try each part, take first valid one
  let price = null
  for (const p of parts) {
    const found = extractPrice(p)
    if (found) { price = found; break }
  }

  // Find structured fields by scanning full text
  const fullText = base
  const occasions  = findAllInText(fullText, OCCASION_KEYWORDS)
  const setupTypes = findAllInText(fullText, SETUP_KEYWORDS)
  const room_hint  = findInText(fullText, ROOM_KEYWORDS)
  const colors     = findColors(fullText)

  // Primary (single) value kept for backward compat — uses first match
  const occasion   = occasions[0] || null
  const setup_type = setupTypes[0] || null

  // Always derive a usable theme — colors first, then descriptive segments,
  // finally a sensible fallback from occasion + setup.
  const theme = deriveTheme(parts, colors, occasion, setup_type)

  // Tags = all useful words minus the structured ones
  const tags = extractTags(fullText)

  return {
    price,
    occasion,          // primary (backward compat)
    occasions,         // all matches (new)
    theme,
    setup_type,        // primary (backward compat)
    setup_types: setupTypes,  // all matches (new)
    room_hint,
    colors,
    tags,
    raw_filename: raw,
  }
}

/**
 * Validate that essential fields were extracted.
 * Returns { ok, missing[] }
 */
export function validateParsed(parsed) {
  const missing = []
  if (!parsed.price)    missing.push('price')
  if (!parsed.occasion) missing.push('occasion')
  return { ok: missing.length === 0, missing }
}
