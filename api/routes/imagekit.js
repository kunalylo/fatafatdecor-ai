import { Router } from 'express'
import { asyncRoute } from '../helpers.js'
import { IMAGEKIT_URL, IMAGEKIT_PRIVATE_KEY, getImageKitFolder } from '../config.js'

const router = Router()

// GET /imagekit/reference
router.get('/imagekit/reference', asyncRoute(async (req, res, ok) => {
  const budget_min = Number(req.query.budget_min || 3000)
  const budget_max = Number(req.query.budget_max || 5000)
  const folder     = getImageKitFolder(budget_min, budget_max)
  return ok({ folder, base_url: IMAGEKIT_URL, folder_url: `${IMAGEKIT_URL}/${folder}`, budget_min, budget_max })
}))

// POST /imagekit/upload
router.post('/imagekit/upload', asyncRoute(async (req, res, ok, err) => {
  const { file_base64, file_name, folder } = req.body
  if (!file_base64 || !file_name) return err('file_base64 and file_name required')
  if (!IMAGEKIT_PRIVATE_KEY) return err('IMAGEKIT_PRIVATE_KEY not configured', 500)
  const auth   = Buffer.from(IMAGEKIT_PRIVATE_KEY + ':').toString('base64')
  const body   = new URLSearchParams()
  body.append('file', file_base64)
  body.append('fileName', file_name)
  body.append('folder', folder || '/uploads')
  const ikRes  = await fetch('https://upload.imagekit.io/api/v1/files/upload', { method: 'POST', headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() })
  const ikData = await ikRes.json()
  if (ikData.url) return ok({ success: true, url: ikData.url, fileId: ikData.fileId })
  return err('ImageKit upload failed: ' + JSON.stringify(ikData), 500)
}))

export default router
