// Single source of truth for budget brackets.
//
// Customer picks one of these. Each reference design is auto-classified
// into one bracket based on its base_price. Backend uses these to validate
// generate-from-reference requests and to compute coverage stats for admin.

export const BUDGET_BRACKETS = [
  { id: 'b1', min: 3000,   max: 5000,    label: 'Rs 3K-5K',    short: '3-5K'   },
  { id: 'b2', min: 5000,   max: 10000,   label: 'Rs 5K-10K',   short: '5-10K'  },
  { id: 'b3', min: 10000,  max: 15000,   label: 'Rs 10K-15K',  short: '10-15K' },
  { id: 'b4', min: 15000,  max: 20000,   label: 'Rs 15K-20K',  short: '15-20K' },
  { id: 'b5', min: 20000,  max: 30000,   label: 'Rs 20K-30K',  short: '20-30K' },
  { id: 'b6', min: 30000,  max: 50000,   label: 'Rs 30K-50K',  short: '30-50K' },
  { id: 'b7', min: 50000,  max: 100000,  label: 'Rs 50K-1L',   short: '50K-1L' },
  { id: 'b8', min: 100000, max: 300000,  label: 'Rs 1L+',      short: '1L+'    },
]

/**
 * Find the bracket a price belongs to.
 * Prices below the lowest min go to b1, above the highest max go to the last bracket.
 */
export function bracketForPrice(price) {
  const p = Number(price) || 0
  for (const b of BUDGET_BRACKETS) {
    if (p >= b.min && p <= b.max) return b
  }
  if (p < BUDGET_BRACKETS[0].min) return BUDGET_BRACKETS[0]
  return BUDGET_BRACKETS[BUDGET_BRACKETS.length - 1]
}

/**
 * Validate a [min, max] pair against allowed brackets.
 * Returns the matched bracket or null.
 */
export function findBracket(min, max) {
  const mn = Number(min)
  const mx = Number(max)
  return BUDGET_BRACKETS.find(b => b.min === mn && b.max === mx) || null
}

/**
 * Legacy compatibility: returns [[min,max],...] in the old VALID_BUDGETS format.
 */
export function validBudgetTuples() {
  return BUDGET_BRACKETS.map(b => [b.min, b.max])
}
