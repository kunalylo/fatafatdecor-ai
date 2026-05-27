// Pricing model — single source of truth (backend).
//
// base_price = total selling value of decoration & material (2x markup of cost).
// On top of that, customer pays:
//   • Setup + transportation (tiered by base_price)
//   • Platform fee (flat)
//   • Convenience fee (flat)
//   • GST 18% on the subtotal
//
// Operating margin (admin only) = base_price - sum(items_cost_1x).
// The setup/platform/convenience fees are charged to cover delivery ops
// plus a small operational margin; they are NOT decoration profit.

export const PLATFORM_FEE = 99
export const CONVENIENCE_FEE = 27
export const GST_RATE = 0.18

/**
 * Tiered setup + transportation fee based on the design cost (base_price).
 *   ≤ 10K   → Rs 625
 *   10K-20K → Rs 1,025
 *   > 20K   → Rs 1,325
 */
export function setupTransportFee(basePrice) {
  const p = Number(basePrice) || 0
  if (p <= 10000) return 625
  if (p <= 20000) return 1025
  return 1325
}

/**
 * Compute the full customer-facing breakdown.
 *
 * Returns:
 *   {
 *     decoration_total: 7200,   // base_price (items @ 2x)
 *     setup_transport: 625,
 *     platform_fee:    99,
 *     convenience_fee: 27,
 *     fees_subtotal:   751,     // setup + platform + convenience
 *     subtotal:        7951,    // decoration + fees_subtotal
 *     gst:             1431,
 *     gst_rate:        0.18,
 *     total:           9382,
 *   }
 */
export function customerBreakdown(basePrice) {
  const decoration = Math.round(Number(basePrice) || 0)
  const setupTransport = setupTransportFee(decoration)
  const feesSubtotal = setupTransport + PLATFORM_FEE + CONVENIENCE_FEE
  const subtotal     = decoration + feesSubtotal
  const gst          = Math.round(subtotal * GST_RATE)
  const total        = subtotal + gst
  return {
    decoration_total: decoration,
    setup_transport:  setupTransport,
    platform_fee:     PLATFORM_FEE,
    convenience_fee:  CONVENIENCE_FEE,
    fees_subtotal:    feesSubtotal,
    subtotal,
    gst,
    gst_rate:         GST_RATE,
    total,
  }
}

/**
 * Compute admin-only margin info.
 *
 * Returns:
 *   {
 *     items_cost:        1147,  // 1x procurement cost
 *     decoration_total:  7200,  // = base_price
 *     operating_margin:  6053,  // decoration_total - items_cost
 *     margin_percent:    84.1,
 *   }
 */
export function adminMargin(basePrice, itemsCostTotal) {
  const decoration = Math.round(Number(basePrice) || 0)
  const itemsCost  = Math.round((Number(itemsCostTotal) || 0) * 100) / 100
  const margin     = decoration - itemsCost
  const pct        = decoration > 0 ? (margin / decoration) * 100 : 0
  return {
    items_cost:       itemsCost,
    decoration_total: decoration,
    operating_margin: Math.round(margin * 100) / 100,
    margin_percent:   Math.round(pct * 10) / 10,
  }
}
