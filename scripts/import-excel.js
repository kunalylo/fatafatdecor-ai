#!/usr/bin/env node
// CLI tool to import the FatafatDecor Balloon Inventory Excel into MongoDB.
//
// Usage:
//   node scripts/import-excel.js <path-to-xlsx>
//
// Example:
//   node scripts/import-excel.js "C:/Users/ADMIN/Downloads/Fatafat_Decor_AI_Balloon_Inventory_Database_Expanded.xlsx"

import 'dotenv/config'
import { readFile } from 'fs/promises'
import path from 'path'
import XLSX from 'xlsx'
import { v4 as uuidv4 } from 'uuid'
import { connectToMongo } from '../api/db.js'

const SHEET_NAME = 'Master_Balloon_Database'

async function main() {
  const filePath = process.argv[2]
  if (!filePath) {
    console.error('Usage: node scripts/import-excel.js <path-to-xlsx>')
    process.exit(1)
  }

  const absPath = path.resolve(filePath)
  console.log(`[Import] Reading: ${absPath}`)

  const buf = await readFile(absPath)
  const wb  = XLSX.read(buf, { type: 'buffer' })
  const ws  = wb.Sheets[SHEET_NAME]
  if (!ws) {
    console.error(`Sheet "${SHEET_NAME}" not found. Available: ${Object.keys(wb.Sheets).join(', ')}`)
    process.exit(1)
  }

  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' })
  console.log(`[Import] Found ${rows.length} rows`)

  const db = await connectToMongo()
  const col = db.collection('master_inventory')

  // Index for fast SKU lookup + filtering
  await col.createIndex({ sku_code: 1 }, { unique: true })
  await col.createIndex({ category: 1 })
  await col.createIndex({ color: 1 })
  await col.createIndex({ finish: 1 })
  await col.createIndex({ size_inches: 1 })
  await col.createIndex({ active: 1 })

  let imported = 0, updated = 0, errors = 0
  for (const r of rows) {
    try {
      const sku_code = String(r['SKU Code'] || '').trim()
      if (!sku_code) { errors++; continue }

      const doc = {
        sku_code,
        category:       String(r['Category'] || '').trim(),
        subcategory:    String(r['Subcategory'] || '').trim(),
        brand_supplier: String(r['Brand / Supplier Reference'] || '').trim(),
        material:       String(r['Material'] || '').trim(),
        finish:         String(r['Finish'] || '').trim(),
        shape:          String(r['Shape'] || '').trim(),
        size_inches:    Number(r['Size (inches)']) || 0,
        color:          String(r['Colour'] || '').trim(),
        pack_quantity:  Number(r['Pack Quantity']) || 0,
        cost_price_pack:        Number(r['Cost Price Pack (INR)']) || 0,
        per_unit_cost:          Number(r['Per Unit Cost (INR)']) || 0,
        selling_price_pack:     Number(r['Selling Price Pack (INR)']) || 0,
        selling_price_per_unit: Number(r['Selling Price Per Unit (INR)']) || 0,
        city_availability:      String(r['City Availability'] || '').trim(),
        inventory_status:       String(r['Inventory Status'] || 'Active').trim(),
        budget_fit:             String(r['Budget Fit'] || '').trim(),
        source_url:             String(r['Source URL'] || '').trim(),
        image_search_ref:       String(r['Image Search Reference'] || '').trim(),
        ai_usage_notes:         String(r['AI Usage Notes'] || '').trim(),
        // Operational defaults
        stock_count: 0,
        reorder_threshold: 50,
        active: true,
        updated_at: new Date(),
      }

      const existing = await col.findOne({ sku_code })
      if (existing) {
        await col.updateOne({ sku_code }, { $set: doc })
        updated++
      } else {
        doc.id = uuidv4()
        doc.created_at = new Date()
        await col.insertOne(doc)
        imported++
      }
    } catch (e) {
      console.error(`[Import] Row error:`, e.message)
      errors++
    }
  }

  console.log(`[Import] ✅ Done. Imported: ${imported}, Updated: ${updated}, Errors: ${errors}`)
  process.exit(0)
}

main().catch(e => { console.error('[Import] FATAL:', e); process.exit(1) })
