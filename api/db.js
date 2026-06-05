import { MongoClient } from 'mongodb'
import { MONGO_URL, DB_NAME } from './config.js'

let client, db

export async function connectToMongo() {
  if (client && db) return db
  if (!MONGO_URL) throw new Error('MONGO_URL env var not set')
  try {
    client = new MongoClient(MONGO_URL, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS:         5000,
      socketTimeoutMS:          30000,
      maxPoolSize:              10,
      minPoolSize:              1,
      maxIdleTimeMS:            30000,
    })
    await client.connect()
    db = client.db(DB_NAME)
    console.log('[MongoDB] Connected to', DB_NAME)
    await ensureIndexes(db)   // ensure unique indexes exist before the first write
    return db
  } catch (e) {
    client = null
    db     = null
    throw new Error('MongoDB connection failed: ' + e.message)
  }
}

// Idempotent index setup. createIndex is a no-op when the index already exists.
async function ensureIndexes(database) {
  await Promise.all([
    // Unique order ids — back the atomic draft→order promotion in /payments/verify
    database.collection('orders').createIndex({ id: 1 }, { unique: true })
      .catch(e => console.warn('[MongoDB] orders.id index:', e.message)),
    database.collection('draft_orders').createIndex({ id: 1 }, { unique: true })
      .catch(e => console.warn('[MongoDB] draft_orders.id index:', e.message)),
    // Auto-expire abandoned drafts after 30 days — far beyond any real create→pay gap, so a
    // soon-to-be-paid draft is never expired out from under /payments/verify.
    database.collection('draft_orders').createIndex({ created_at: 1 }, { expireAfterSeconds: 2592000 })
      .catch(e => console.warn('[MongoDB] draft_orders TTL index:', e.message)),
    // Payment idempotency — at most one record per Razorpay order / Apple transaction.
    database.collection('payments').createIndex(
      { razorpay_order_id: 1 },
      { unique: true, partialFilterExpression: { razorpay_order_id: { $type: 'string' } } },
    ).catch(e => console.warn('[MongoDB] payments.razorpay_order_id index:', e.message)),
    database.collection('payments').createIndex(
      { apple_transaction_id: 1 },
      { unique: true, partialFilterExpression: { apple_transaction_id: { $type: 'string' } } },
    ).catch(e => console.warn('[MongoDB] payments.apple_transaction_id index:', e.message)),
  ])
}
