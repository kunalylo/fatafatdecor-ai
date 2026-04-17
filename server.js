import 'dotenv/config'
import express from 'express'
import cors from 'cors'

import authRoutes      from './api/routes/auth.js'
import cityRoutes      from './api/routes/cities.js'
import itemRoutes      from './api/routes/items.js'
import kitRoutes       from './api/routes/kits.js'
import designRoutes    from './api/routes/designs.js'
import orderRoutes     from './api/routes/orders.js'
import paymentRoutes   from './api/routes/payments.js'
import deliveryRoutes  from './api/routes/delivery.js'
import decoratorRoutes from './api/routes/decorators.js'
import giftRoutes      from './api/routes/gifts.js'
import adminRoutes     from './api/routes/admin.js'
import userRoutes      from './api/routes/user.js'
import imagekitRoutes  from './api/routes/imagekit.js'
import seedRoutes      from './api/routes/seed.js'

const app  = express()
const PORT = process.env.PORT || 3000

// ── CORS ───────────────────────────────────────────────────────────
const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map(s => s.trim())
  : ['*']

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
      cb(null, true)
    } else {
      cb(new Error('Not allowed by CORS: ' + origin))
    }
  },
  credentials: true,
}))

// ── Body parser (50 MB for base64 images) ─────────────────────────
app.use(express.json({ limit: '50mb' }))
app.use(express.urlencoded({ extended: true, limit: '50mb' }))

// ── Health check ──────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'FatafatDecor Express API', timestamp: new Date().toISOString() })
})

// ── AI service warmup proxy ───────────────────────────────────────
app.get('/api/ai-warmup', async (_req, res) => {
  try {
    const r = await fetch('http://localhost:8001/health')
    const d = await r.json()
    res.json({ express: 'ok', fastapi: d })
  } catch (e) {
    res.status(503).json({ express: 'ok', fastapi: 'unavailable', error: e.message })
  }
})

// ── API routes ────────────────────────────────────────────────────
app.use('/api', authRoutes)
app.use('/api', cityRoutes)
app.use('/api', itemRoutes)
app.use('/api', kitRoutes)
app.use('/api', designRoutes)
app.use('/api', orderRoutes)
app.use('/api', paymentRoutes)
app.use('/api', deliveryRoutes)
app.use('/api', decoratorRoutes)
app.use('/api', giftRoutes)
app.use('/api', userRoutes)
app.use('/api', adminRoutes)
app.use('/api', imagekitRoutes)
app.use('/api', seedRoutes)

// ── 404 fallback ──────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found' })
})

// ── Global error handler ──────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[Unhandled Error]', err)
  res.status(500).json({ error: err.message || 'Internal server error' })
})

app.listen(PORT, () => {
  console.log(`FatafatDecor API running on port ${PORT}`)
})
