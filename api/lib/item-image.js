// Item product-shot images for master_inventory SKUs.
// Every item should have an image: admins upload real photos, or we AI-generate
// a clean product shot (FLUX schnell via FastAPI /generate-item-image, ~2-4s).

import { AI_SERVICE_URL, IMAGEKIT_PRIVATE_KEY } from '../config.js'

export async function uploadItemImageToImageKit(buffer, filename) {
  if (!IMAGEKIT_PRIVATE_KEY) throw new Error('IMAGEKIT_PRIVATE_KEY not configured')
  const ikAuth = Buffer.from(IMAGEKIT_PRIVATE_KEY + ':').toString('base64')
  const body = new URLSearchParams()
  body.append('file', buffer.toString('base64'))
  body.append('fileName', filename)
  body.append('folder', '/items')
  const res = await fetch('https://upload.imagekit.io/api/v1/files/upload', {
    method: 'POST',
    headers: { 'Authorization': `Basic ${ikAuth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  const data = await res.json()
  if (!data.url) throw new Error('ImageKit upload failed: ' + JSON.stringify(data))
  return { image_url: data.url, file_id: data.fileId }
}

/**
 * Generate an AI product shot for a SKU and save it on the item.
 * Returns the ImageKit URL. Throws on failure — callers decide whether
 * that's fatal (admin button) or ignorable (fire-and-forget on auto-create).
 */
export async function generateAndAttachItemImage(db, item) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 60000)
  let data
  try {
    const res = await fetch(`${AI_SERVICE_URL}/generate-item-image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        category:    item.category    || '',
        subcategory: item.subcategory || '',
        color:       item.color       || '',
        finish:      item.finish      || '',
        shape:       item.shape       || '',
        size_inches: Number(item.size_inches) || 0,
        material:    item.material    || '',
      }),
      signal: ctrl.signal,
    })
    data = await res.json()
  } finally { clearTimeout(t) }
  if (!data?.success || !data.image_url) {
    throw new Error(data?.error || 'item image generation failed')
  }

  const imgRes = await fetch(data.image_url, { signal: AbortSignal.timeout(30000) })
  if (!imgRes.ok) throw new Error(`could not download generated image (${imgRes.status})`)
  const buffer = Buffer.from(await imgRes.arrayBuffer())

  const safe = String(item.sku_code || item.id || 'item').replace(/[^A-Za-z0-9_-]+/g, '_')
  const ik = await uploadItemImageToImageKit(buffer, `item_${safe}.jpg`)

  await db.collection('master_inventory').updateOne(
    { $or: [{ id: item.id }, { sku_code: item.sku_code }] },
    { $set: { image_url: ik.image_url, image_file_id: ik.file_id, image_auto_generated: true, updated_at: new Date() } },
  )
  return ik.image_url
}
