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
    return db
  } catch (e) {
    client = null
    db     = null
    throw new Error('MongoDB connection failed: ' + e.message)
  }
}
